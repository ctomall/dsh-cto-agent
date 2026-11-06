#!/usr/bin/env node
// 浏览器级验证：模型只输出思考、没有正文时，界面必须给出说明（而不是只显示"完成"）。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'empty-'))
const MOCK_PORT = 8951, APP_PORT = 8952
const mock = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '我在想…' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))
const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env, APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    MODEL_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, MODEL_NAME: 'think', MODEL_API_KEY: 'sk-t',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
  },
  stdio: 'ignore',
})
const cleanup = () => { try { app.kill('SIGKILL') } catch {}; try { mock.close() } catch {} }
process.on('exit', cleanup)
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {} }
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '纯思考' }) })).json()

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 40000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid}&token=tok_a` }, 25000)
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(300) }
await ev(`(() => { document.querySelector('#input').value = '解释一下'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true })()`)
let info = null
for (let i = 0; i < 40; i++) {
  await sleep(300)
  info = await ev(`({ note: document.body.textContent.includes('模型这次没有返回正文'), status: document.querySelector('#runlabel')?.textContent ?? '' })`)
  if (info.note) break
}
const ok = !!info?.note
console.log(JSON.stringify({ ...info, ok }))
await raw('Page.close', {}, 3000).catch(() => {})
ws.close(); cleanup()
process.exit(ok ? 0 : 1)
