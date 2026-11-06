#!/usr/bin/env node
// 浏览器级验证（确定性、临时实例）：会话筛选 → 重命名 → 两段删除
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'ops-'))
const APP_PORT = 8882
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
const titles = ['甲报告', '乙报告', '丙记录']
for (const t of titles) await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: t }) })

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 30000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(250) } return false }
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=tok_a` }, 20000)
await until(`document.querySelectorAll('#sessions li').length >= 3`)

// 1) 筛选
const f = await ev(`(() => { const b=document.querySelector('#session-filter'); b.value='甲'; b.dispatchEvent(new Event('input',{bubbles:true}));
  return { visible: [...document.querySelectorAll('#sessions li')].filter(l=>!l.hidden).length, count: document.querySelector('#session-count').textContent } })()`)
await ev(`(() => { const b=document.querySelector('#session-filter'); b.value=''; b.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)

// 2) 重命名：点行进入会话 → 双击标题栏（#title）→ 输入 → Enter
await ev(`(() => {
  const li=[...document.querySelectorAll('#sessions li')].find(l=>String(l.dataset.title)==='甲报告')
  li?.querySelector('.row-title')?.click(); return true
})()`)
await until(`document.querySelector('#title')?.textContent?.includes('甲报告')`, 8000)
const r1 = await ev(`(() => { const t=document.querySelector('#title'); if(!t) return 'no-title'
  t.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok' })()`)
await sleep(250)
const r2 = await ev(`(() => { const b=document.querySelector('#title input.title-input') || document.querySelector('#title input')
  if(!b) return 'no-input'
  b.value='甲报告-改名'
  b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true, cancelable:true}))
  return 'ok' })()`)
await sleep(1200)
const renamed = await ev(`document.querySelector('#title')?.textContent?.includes('甲报告-改名') ?? false`)

// 3) 两段删除
const d1 = await ev(`(() => {
  const li=[...document.querySelectorAll('#sessions li')].find(l=>String(l.dataset.title).includes('甲报告')); if(!li) return 'no-row'
  const b=li.querySelector('.row-del'); b.click(); b.click(); return 'ok' })()`)
await until(`![...document.querySelectorAll('#sessions li')].some(l=>String(l.dataset.title).includes('甲报告'))`, 8000)
const gone = await ev(`![...document.querySelectorAll('#sessions li')].some(l=>String(l.dataset.title).includes('甲报告'))`)
const apiList = (await ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>d.sessions.map(s=>s.title))`)) ?? []
const apiArr = Array.isArray(apiList) ? apiList : []

const ok = f?.visible === 1 && renamed && gone
console.log(JSON.stringify({ filter: f, dblclick: r1, submit: r2, renamed, deleted: gone, apiHas: apiArr.includes('甲报告-改名'), ok }))
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
process.exit(ok ? 0 : 1)
