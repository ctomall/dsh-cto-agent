// 模型驱动层：loop 只依赖 complete()，不关心是假模型还是真实 provider。
// 真实 provider 的 key 只从环境/密钥文件读，绝不入库。
export function createFakeDriver() {
  return {
    name: 'fake',
    async complete({ messages }) {
      const toolsDone = messages.filter((m) => m.role === 'tool')
      const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''

      if (toolsDone.length === 0) {
        if (/写|保存|生成|汇总/.test(user)) {
          return { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'report.md', content: '# 汇总报告\n\n由模型决定调用 fs.write 生成。' } } }
        }
        if (/读|查看|打开/.test(user)) {
          return { type: 'tool_call', call: { id: 'c1', name: 'fs.read', args: { path: 'report.md' } } }
        }
        return { type: 'final', text: `（fake）不需要工具：${user}` }
      }

      const last = toolsDone.at(-1)
      return { type: 'final', text: `已完成。工具结果：${String(last.content).slice(0, 160)}` }
    },
  }
}

// OpenAI 兼容端点（DeepSeek / OpenAI / 兼容网关均可）
export function createOpenAiDriver({ baseUrl, apiKey, model, timeoutMs = 60_000, stream = true }) {
  return {
    name: `openai:${model}`,
    async complete({ messages, tools, onDelta, signal }) {
      const body = {
        model,
        messages: messages.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content) }
            : { role: m.role, content: m.content },
        ),
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: 'auto',
        ...(stream && onDelta ? { stream: true } : {}),
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
      try {
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
        const maxRetries = 2
        let res
        for (let attempt = 0; ; attempt++) {
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(body),
              signal: ctrl.signal,
            })
          } catch (e) {
            if (attempt >= maxRetries || ctrl.signal.aborted) throw e
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
            continue
          }
          if (res.ok) break
          // 4xx 是请求问题，重试无意义；5xx/429 才退避重试
          if ((res.status < 500 && res.status !== 429) || attempt >= maxRetries) {
            throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 200)}`)
          }
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        }

        // 流式：逐块推 text.delta（事件序列由模型输出驱动），并累积 tool_calls 分片
        if (stream && onDelta && String(res.headers.get('content-type') || '').includes('text/event-stream')) {
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          let text = ''
          const calls = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              const t = line.trim()
              if (!t.startsWith('data:')) continue
              const payload = t.slice(5).trim()
              if (payload === '[DONE]') continue
              let chunk
              try { chunk = JSON.parse(payload) } catch { continue }
              const delta = chunk.choices?.[0]?.delta ?? {}
              if (delta.content) {
                text += delta.content
                onDelta(delta.content)
              }
              for (const tc of delta.tool_calls ?? []) {
                const i = tc.index ?? 0
                calls[i] ??= { id: tc.id ?? `call_${i}`, name: '', arguments: '' }
                if (tc.id) calls[i].id = tc.id
                if (tc.function?.name) calls[i].name += tc.function.name
                if (tc.function?.arguments) calls[i].arguments += tc.function.arguments
              }
            }
          }
          const first = calls.find(Boolean)
          if (first?.name) {
            let args = {}
            try { args = JSON.parse(first.arguments || '{}') } catch { args = {} }
            // 并行 tool_call：loop 一次只执行一个，多出来的必须显式回报，不能静默丢弃
            const others = calls.filter((c, i) => c && c !== first).map((c) => ({ id: c.id, name: c.name }))
            return { type: 'tool_call', call: { id: first.id, name: first.name, args }, others }
          }
          return { type: 'final', text }
        }

        const j = await res.json()
        const msg = j.choices?.[0]?.message ?? {}
        if (msg.tool_calls?.length) {
          const tc = msg.tool_calls[0]
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = {} }
          const others = msg.tool_calls.slice(1).map((c) => ({ id: c.id, name: c.function?.name ?? '' }))
          return { type: 'tool_call', call: { id: tc.id, name: tc.function.name, args }, others }
        }
        return { type: 'final', text: msg.content ?? '' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// 从环境装配：没有 key 就退回 fake，并说明原因（不静默）
import { readFileSync } from 'node:fs'

export function loadKeyFromFile(path) {
  if (!path) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    return raw.startsWith('sk-') || raw.length >= 16 ? raw : null
  } catch {
    return null
  }
}

export function createDriverFromEnv(env = process.env) {
  const baseUrl = env.MODEL_BASE_URL
  const model = env.MODEL_NAME
  const apiKey = env.MODEL_API_KEY ?? loadKeyFromFile(env.MODEL_API_KEY_FILE)
  if (baseUrl && model && apiKey) {
    return { driver: createOpenAiDriver({ baseUrl, apiKey, model }), source: env.MODEL_API_KEY ? 'env' : 'key-file' }
  }
  const missing = [!baseUrl && 'MODEL_BASE_URL', !model && 'MODEL_NAME', !apiKey && (env.MODEL_API_KEY_FILE ? 'MODEL_API_KEY_FILE(读不到内容)' : 'MODEL_API_KEY')].filter(Boolean)
  return { driver: createFakeDriver(), source: missing.length ? `fake(missing: ${missing.join(',')})` : 'fake(default)' }
}
