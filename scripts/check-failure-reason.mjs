#!/usr/bin/env node
// 浏览器级验证：三类失败都要在界面上给出原因（状态栏 + 失败卡片）。
// SCENARIO=400|timeout|steps  分别对应 provider 4xx / 运行超时 / 超过最大步数
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCENARIO = process.env.SCENARIO || '400'
const work = mkdtempSync(join(tmpdir(), `fail-${SCENARIO}-`))
const MOCK_PORT = 8831, APP_PORT = 8832

const mock = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', async () => {
    if (SCENARIO === '400') {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'mock: bad request' } }))
    }
    if (SCENARIO === 'timeout') {
      await new Promise((r) => setTimeout(r, 5000)) // 超过 AGENT_TIMEOUT_MS
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: '太慢了' }, finish_reason: 'stop' }] }))
    }
    // steps：永远要工具（fs.read 是 auto，不需要审批）→ 直到超过最大步数
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":"nope.md"}' } }] } }] }))
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
    AGENT_TIMEOUT_MS: '1500', AGENT_MAX_STEPS: '3',
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
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: `失败-${SCENARIO}` }) })).json()

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 40000) => Promise.race([
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
await ev(`(() => {
  document.querySelector('#input').value = '随便写点什么'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return true
})()`)

let info = null
for (let i = 0; i < 30; i++) {
  await sleep(400)
  info = await ev(`({
    status: document.querySelector('#runlabel')?.textContent ?? null,
    errorCard: document.querySelectorAll('.card.error').length,
    errorText: document.querySelector('.card.error .body p')?.textContent ?? null,
    subCalls: window.__subCalls ?? 0,
    subArgs: window.__subArgs ?? [],
  })`)
  if (info.errorCard > 0) break
}
const expect = { '400': /provider 400/, timeout: /timeout/i, steps: /最大步数/ }[SCENARIO]
const ok = info.errorCard > 0 && expect.test(String(info.errorText ?? '')) && String(info.status).startsWith('失败')
console.log(JSON.stringify({ scenario: SCENARIO, ...info, ok }))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
cleanup()
process.exit(ok ? 0 : 1)
