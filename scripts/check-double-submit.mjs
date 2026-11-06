#!/usr/bin/env node
// 浏览器级验证：连按两次发送，只能创建一个 run（真模型下每次都计费）。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'dbl-'))
const APP_PORT = 8912
const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env, APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
    AGENT_TIMEOUT_MS: '6000',
  },
  stdio: 'ignore',
})
process.on('exit', () => { try { app.kill('SIGKILL') } catch {} })
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {} }

const H = { authorization: 'Bearer tok_a', 'content-type': 'application/json' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '双发' }) })).json()

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 30000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid}&token=tok_a` }, 25000)
for (let i = 0; i < 30; i++) { if (await ev(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(300) }
await ev(`(() => {
  const i = document.querySelector('#input'); const f = document.querySelector('#composer')
  i.value = '连按两次'
  const fire = () => f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  fire()                        // 第一次正常提交
  i.value = '再来一次'            // 用户再次输入并连按：重复提交的真实形态
  fire(); fire()
  return true
})()`)
await sleep(1500)
// 直接用数据库数 run（应用用的是同一个 sqlite 文件，WAL 下其它连接可读）
const db = new DatabaseSync(join(work, 'cube.db'))
const count = Number(db.prepare('select count(*) c from runs where session_id = ?').get(sid).c)
db.close()
const status = await ev(`document.querySelector('#runlabel')?.textContent ?? ''`)
const ok = count === 1
console.log(JSON.stringify({ runCount: count, status, ok }))
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
