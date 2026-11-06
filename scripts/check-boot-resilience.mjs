#!/usr/bin/env node
// 浏览器级验证：boot 期间某个接口失败（模拟丢包），页面仍必须渲染会话列表。
// 用 CDP 的 Network.setBlockedURLs 精确阻断 /api/model/status。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'boot-'))
const APP_PORT = 8872
const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env, APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
  },
  stdio: 'ignore',
})
process.on('exit', () => { try { app.kill('SIGKILL') } catch {} })
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {} }

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
for (const t of ['甲', '乙', '丙']) await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: `会话${t}` }) })

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 40000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setBlockedURLs', { urls: ['*/api/model/status*'] })
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=tok_a` }, 25000)

let info = null
for (let i = 0; i < 30; i++) {
  await sleep(400)
  info = await ev(`({ rows: document.querySelectorAll('#sessions li').length, driver: document.querySelector('#sbDriver')?.textContent ?? null })`)
  if (info.rows > 0) break
}
const filtered = await ev(`(() => {
  const b = document.querySelector('#session-filter')
  if (!b) return null
  b.value = '会话甲'; b.dispatchEvent(new Event('input', { bubbles: true }))
  return [...document.querySelectorAll('#sessions li')].filter(l => !l.hidden).length
})()`)
const ok = info && info.rows >= 3 && filtered === 1
console.log(JSON.stringify({ ...info, filtered, ok }))
await raw('Network.setBlockedURLs', { urls: [] }).catch(() => {})
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
