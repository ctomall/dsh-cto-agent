#!/usr/bin/env node
// 浏览器实测重命名：双击标题 → 输入 → Enter，随后核对 DOM 与 API。
// 用法：CK=<cookie> SID=<sessionId> node scripts/cdp-rename-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
const CK = process.env.CK, SID = process.env.SID, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: `${BASE}/?sid=${SID}` }, 25000)
for (let i = 0; i < 30; i++) { if (await ev(`!!document.querySelector('#title')`)) break; await new Promise((r) => setTimeout(r, 500)) }
await new Promise((r) => setTimeout(r, 1500))
// 记录 PATCH 调用
await ev(`(() => { window.__patches = []; const of = window.fetch; window.fetch = (u, o) => { if ((o?.method || 'GET') === 'PATCH') window.__patches.push(String(u)); return of(u, o) }; return true })()`)
const state0 = await ev(`({ title: document.querySelector('#title').textContent, editing: document.querySelector('#title').dataset.editing })`)
await ev(`document.querySelector('#title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
const s1 = await ev(`({ inputs: document.querySelectorAll('.title-input').length, editing: document.querySelector('#title').dataset.editing })`)
await new Promise((r) => setTimeout(r, 200))
const s2 = await ev(`({ inputs: document.querySelectorAll('.title-input').length, editing: document.querySelector('#title').dataset.editing, active: document.activeElement?.className })`)
// 输入新名并回车
await ev(`(() => { const i = document.querySelector('.title-input'); i.value = ${JSON.stringify('CDP 改名成功')}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
await new Promise((r) => setTimeout(r, 1800))
const afterEnter = await ev(`({ title: document.querySelector('#title').textContent, inputs: document.querySelectorAll('.title-input').length, editing: document.querySelector('#title').dataset.editing })`)
console.log(JSON.stringify({ state0, afterDispatch: s1, after200ms: s2, afterEnter, patches: await ev('window.__patches') }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
