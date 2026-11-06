#!/usr/bin/env node
// 浏览器级验证：boot 中某一步"卡住不返回"时，页面仍必须完成绑定（筛选可用）。
// 用 CDP Fetch 域拦截 /api/artifacts 并永不 fulfill，模拟半开连接。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'hang-'))
const APP_PORT = 8892
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
for (const t of ['卡甲', '卡乙']) await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: t }) })

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map(); let held = 0
const raw = (m, p = {}, ms = 40000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Fetch.requestPaused') { held += 1 } // 刻意不 continueRequest：让请求永远挂着
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions/*/artifacts*' }] })
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=tok_a` }, 25000)

const t0 = Date.now()
let info = null
for (let i = 0; i < 40; i++) {
  await sleep(250)
  info = await ev(`({ rows: document.querySelectorAll('#sessions li').length })`)
  if (info.rows >= 2) break
}
// 等到筛选真的可用（最多 20s，boot 每步超时 8s）
let filtered = -1
for (let i = 0; i < 40; i++) {
  filtered = await ev(`(() => { const b=document.querySelector('#session-filter'); if(!b) return -1
    b.value='卡甲'; b.dispatchEvent(new Event('input',{bubbles:true}))
    return [...document.querySelectorAll('#sessions li')].filter(l=>!l.hidden).length })()`).catch(() => -1)
  if (filtered === 1) break
  await sleep(250)
}
// 绑定必须"早于/不依赖"数据加载：即使某个接口挂着，也要在 5s 内可用
const bindMs = Date.now() - t0
const ok = info.rows >= 2 && filtered === 1 && bindMs < 5000
console.log(JSON.stringify({ rows: info && info.rows, filtered, bindMs, held, ok }))
await raw('Fetch.disable').catch(() => {})
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
