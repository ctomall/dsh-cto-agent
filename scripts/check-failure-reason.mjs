#!/usr/bin/env node
// 浏览器级验证：run 失败时，界面必须显示失败原因（而不是只有一个"失败"）。
// 做法：mock provider 返回非法形状 → loop 判 invalid_model_output → 页面应出现失败卡片与原因。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'fail-reason-'))
const MOCK_PORT = 8821, APP_PORT = 8822

const mock = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    // provider 直接 400：驱动抛错 → loop 记 run.failed（真实模型里最常见的失败之一）
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'mock: bad request' } }))
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env,
    APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    MODEL_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, MODEL_NAME: 'mock', MODEL_API_KEY: 'sk-mock',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
  },
  stdio: 'ignore',
})
const cleanup = () => { try { app.kill('SIGKILL') } catch {}; try { mock.close() } catch {} }
process.on('exit', cleanup)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {}
}

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '失败原因' }) })).json()

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 30000) => Promise.race([
  new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms)),
])
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid}&token=tok_a` }, 25000)
for (let i = 0; i < 25; i++) { if (await ev(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(400) }

// 在页面里发一次（走真实前端路径：提交 → 订阅 SSE → 收 run.failed）
await ev(`(() => {
  const t = document.querySelector('#input')
  t.value = '随便写点什么'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return true
})()`)

let info = null
for (let i = 0; i < 25; i++) {
  await sleep(400)
  info = await ev(`({
    status: document.querySelector('#runlabel')?.textContent ?? null,
    errorCard: document.querySelectorAll('.card.error').length,
    errorText: document.querySelector('.card.error .body p')?.textContent ?? null,
  })`)
  if (info.errorCard > 0) break
}
const ok = info.errorCard > 0 && String(info.errorText ?? '').length > 0 && String(info.status).includes('失败')
console.log(JSON.stringify({ ...info, ok }))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
cleanup()
process.exit(ok ? 0 : 1)
