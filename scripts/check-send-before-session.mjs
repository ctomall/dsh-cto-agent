#!/usr/bin/env node
// 浏览器级验证：会话列表还没回来（或很慢）时立刻发送，也必须能建出 run。
// 做法：CDP Fetch 把 GET /api/sessions 挂 4 秒，期间就点发送。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'sbs-'))
const APP_PORT = 8902
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

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map(); let heldList = 0
const raw = (m, p = {}, ms = 40000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Fetch.requestPaused') {
    const reqId = m.params.requestId
    const url = m.params.request.url
    const isList = m.params.request.method === 'GET' && /\/api\/sessions(\?|$)/.test(url)
    if (isList && heldList === 0) {
      heldList = 1
      setTimeout(() => { raw('Fetch.continueRequest', { requestId: reqId }).catch(() => {}) }, 4000) // 挂 4 秒
      return
    }
    raw('Fetch.continueRequest', { requestId: reqId }).catch(() => {})
  }
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions*' }] })
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=tok_a` }, 25000)
await sleep(800) // 列表还在挂着，此时提交
const submitted = await ev(`(() => {
  const i = document.querySelector('#input'); const f = document.querySelector('#composer')
  if (!i || !f) return 'no-form'
  i.value = '慢列表下立刻发送'; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return 'ok'
})()`)
await sleep(6000)
const runs = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { headers: { authorization: 'Bearer tok_a' } })).json()
const last = runs.sessions.at(-1)
const msgCount = last ? (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions/${last.id}/messages`, { headers: { authorization: 'Bearer tok_a' } })).json()).messages?.length ?? 0 : 0
const status = await ev(`document.querySelector('#runlabel')?.textContent ?? ''`)
const ok = submitted === 'ok' && !!last && msgCount > 0 && !String(status).includes('无法创建会话')
console.log(JSON.stringify({ submitted, heldList, session: last?.id ?? null, msgCount, status, ok }))
await raw('Fetch.disable').catch(() => {})
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
