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
export function createOpenAiDriver({ baseUrl, apiKey, model, timeoutMs = 60_000 }) {
  return {
    name: `openai:${model}`,
    async complete({ messages, tools }) {
      const body = {
        model,
        messages: messages.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content) }
            : { role: m.role, content: m.content },
        ),
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: 'auto',
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const j = await res.json()
        const msg = j.choices?.[0]?.message ?? {}
        if (msg.tool_calls?.length) {
          const tc = msg.tool_calls[0]
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = {} }
          return { type: 'tool_call', call: { id: tc.id, name: tc.function.name, args } }
        }
        return { type: 'final', text: msg.content ?? '' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// 从环境装配：没有 key 就退回 fake，并说明原因（不静默）
export function createDriverFromEnv(env = process.env) {
  const baseUrl = env.MODEL_BASE_URL
  const model = env.MODEL_NAME
  const apiKey = env.MODEL_API_KEY
  if (baseUrl && model && apiKey) return { driver: createOpenAiDriver({ baseUrl, apiKey, model }), source: 'env' }
  return { driver: createFakeDriver(), source: baseUrl || model ? 'fake(missing-key)' : 'fake(default)' }
}
