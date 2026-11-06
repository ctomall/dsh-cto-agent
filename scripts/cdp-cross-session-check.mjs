#!/usr/bin/env node
// ② 的另一半：会话授权不跨会话继承。A 会话批准后，B 会话同一工具必须重新弹卡。
// 用法：CK=<cookie> A=<sessionA> B=<sessionB> node scripts/cdp-cross-session-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
// ② 的另一半：会话授权不跨会话继承。A 会话批准后，B 会话同一工具必须重新弹卡
const CK = process.env.CK, A = process.env.A, B = process.env.B, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(expr, label, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(400) } throw new Error('超时：' + label) }
const send = (text) => ev(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit(); return true })()`)
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })

// A 会话：批准「本会话允许」
await raw('Page.navigate', { url: `${BASE}/?sid=${A}` }, 25000)
await until(`!!document.querySelector('#input')`, 'A 输入框')
await send('写一份报告')
await until(`!!document.querySelector('.card.approval')`, 'A 审批卡')
await ev(`document.querySelector('.card.approval .btn:nth-child(2)').click()`)
await until(`document.querySelector('#sbStatus')?.textContent?.includes('完成')`, 'A 完成')
const aState = await ev(`({ approvals: document.querySelectorAll('.card.approval').length, granted: document.querySelector('#grants')?.innerText })`)

// B 会话：同一工具应重新弹卡
await raw('Page.navigate', { url: `${BASE}/?sid=${B}` }, 25000)
await until(`!!document.querySelector('#input')`, 'B 输入框')
await send('写一份报告')
await until(`!!document.querySelector('.card.approval')`, 'B 审批卡')
const bState = await ev(`({ approvals: document.querySelectorAll('.card.approval').length, cardText: document.querySelector('.card.approval')?.innerText.slice(0, 60) })`)
console.log(JSON.stringify({ aState, bState }))
await e0()
async function e0() { await raw('Page.close', {}, 5000).catch(() => {}); ws.close() }
