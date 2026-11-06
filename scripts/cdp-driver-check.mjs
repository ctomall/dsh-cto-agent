#!/usr/bin/env node
// 运行时校验：状态栏必须如实显示驱动。
// 用法：CK=<cookie> node scripts/cdp-driver-check.mjs [base]
// 依赖一个已开启 --remote-debugging-port=9222 的 Chromium。
const CK = process.env.CK, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true })).result?.value
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: BASE + '/' }, 25000)
await new Promise((r) => setTimeout(r, 3000))
const info = await ev(`({ text: document.querySelector('#sbDriver')?.textContent, real: document.querySelector('#sbDriver')?.dataset.real, title: document.querySelector('#sbDriver')?.title })`)
// 结论：状态栏必须"如实"——演示驱动要说演示，真实驱动要标 real=1 且写出驱动名
const text = String(info?.text ?? '')
const saysFake = /演示驱动/.test(text)
const ok = saysFake
  ? info?.real === '0' && /未配置真实模型|未接模型/.test(String(info?.title ?? ''))
  : Boolean(text) && info?.real === '1'
console.log(JSON.stringify({ text: info?.text, real: info?.real, title: info?.title, verdict: { saysFake, ok } }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
