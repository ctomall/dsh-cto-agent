#!/usr/bin/env node
// 浏览器级验证：会话列表还没回来（或很慢）时立刻发送，也必须能建出 run。
// 做法：CDP Fetch 把 GET /api/sessions 挂 4 秒，期间就点发送。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
// 记录提交前已有会话，事后用差异定位（id 是随机串，靠顺序猜不稳）
const beforeIds = new Set(((await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { headers: { authorization: 'Bearer tok_a' } })).json()).sessions ?? []).map((x) => x.id))
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=tok_a` }, 25000)
await sleep(800) // 列表还在挂着，此时提交
const submitted = await ev(`(() => {
  const i = document.querySelector('#input'); const f = document.querySelector('#composer')
  if (!i || !f) return 'no-form'
  i.value = '慢列表下立刻发送'; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return 'ok'
})()`)
// 断言语义：提交必须真的建出一条 run 并跑完，而不是"提交失败"
const db = new DatabaseSync(join(work, 'cube.db'))
let runCount = 0
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 300))
  runCount = Number(db.prepare('select count(*) c from runs').get().c)
  if (runCount >= 1) {
    const st = db.prepare('select status from runs order by started_at desc limit 1').get()?.status
    if (st === 'done' || st === 'failed') break
  }
}
const status = await ev(`document.querySelector('#runlabel')?.textContent ?? ''`)
const ok = submitted === 'ok' && runCount >= 1 && !String(status).includes('提交失败') && !String(status).includes('无法创建会话')
console.log(JSON.stringify({ submitted, heldList, runCount, status, ok }))
await raw('Fetch.disable').catch(() => {})
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
