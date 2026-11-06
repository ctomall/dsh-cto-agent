#!/usr/bin/env node
// 端到端"慢模型"演练（尽量贴近 ① 的验收形状，但不依赖真实厂商）：
// 目标 -> 模型选工具 -> 审批 -> 产出，每步模型都要 8 秒。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DELAY = Number(process.env.STEP_DELAY_MS ?? 8000)
const work = mkdtempSync(join(tmpdir(), 'slowmodel-'))
const MOCK_PORT = 8931, APP_PORT = 8932

const mock = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = (() => { try { return JSON.parse(raw) } catch { return {} } })()
    const hasTool = (body.messages ?? []).some((m) => m.role === 'tool')
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (!hasTool) {
        res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.write', arguments: JSON.stringify({ path: 'slow.md', content: '# 慢模型产物' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已按你的目标写好 slow.md' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }))
      }
    }, DELAY)
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env, APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    MODEL_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, MODEL_NAME: 'slow', MODEL_API_KEY: 'sk-slow',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
    AGENT_TIMEOUT_MS: '120000',
  },
  stdio: 'ignore',
})
const cleanup = () => { try { app.kill('SIGKILL') } catch {}; try { mock.close() } catch {} }
process.on('exit', cleanup)
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {} }

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '慢模型' }) })).json()

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 60000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid}&token=tok_a` }, 25000)
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(300) }

const t0 = Date.now()
await ev(`(() => { document.querySelector('#input').value = '写一份验收报告到 slow.md'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true })()`)

// 1) 等审批卡（慢模型：应大于 DELAY，且页面不能超时/空白）
let approvalAt = null
for (let i = 0; i < 120; i++) {
  if (await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '允许一次')`).catch(() => false)) { approvalAt = Date.now() - t0; break }
  await sleep(250)
}
if (!approvalAt) { console.log(JSON.stringify({ ok: false, step: 'approval', elapsed: Date.now() - t0 })); cleanup(); process.exit(1) }

// 2) 批准 → 等产物
const tApprove = Date.now()
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '允许一次'); b?.click(); return !!b })()`)
let artifactAt = null
for (let i = 0; i < 120; i++) {
  if (await ev(`document.querySelectorAll('.stream-inner .artifact').length > 0`).catch(() => false)) { artifactAt = Date.now() - tApprove; break }
  await sleep(250)
}
// 3) 产物之后还有一步模型调用（同样要 DELAY），要再等它出最终文本
let finalText = false
const tFinal = Date.now()
for (let i = 0; i < 160; i++) {
  finalText = await ev(`document.body.textContent.includes('已按你的目标写好')`).catch(() => false)
  if (finalText) break
  await sleep(250)
}
const finalMs = finalText ? Date.now() - tFinal : null
const ok = !!artifactAt && finalText
console.log(JSON.stringify({ ok, delayMs: DELAY, approvalMs: approvalAt, artifactMs: artifactAt, finalMs, finalText }))
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
cleanup()
process.exit(ok ? 0 : 1)
