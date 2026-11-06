#!/usr/bin/env node
// 公网 Cookie 模式下逐页检查：总览 / 产物 / 设置 / 工作台
// 判据：页面等到"有数据"的信号（而非初始占位符），并对丢包做重试。
// 用法：PW=<口令> BASE=https://cto.ila3.top node scripts/cdp-public-pages.mjs
const PW = process.env.PW, BASE = process.env.BASE || 'https://cto.ila3.top'
if (!PW) { console.error('需要 PW'); process.exit(2) }

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 40000) =>
  Promise.race([
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
async function until(expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(400) }
  return false
}
await raw('Runtime.enable'); await raw('Page.enable')

// 登录（带重试：公网链路存在丢包）
async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await raw('Page.navigate', { url: `${BASE}/login` }, 40000).catch(() => {})
    if (!(await until(`!!document.querySelector('input[name=password]')`, 15000))) continue
    await ev(`(() => { const i=document.querySelector('input[name=password]'); i.value=${JSON.stringify(PW)}; document.querySelector('form').submit(); return true })()`)
    if (await until(`location.pathname === '/'`, 20000)) {
      const me = await ev(`fetch('/api/me').then(r=>r.status)`).catch(() => 0)
      if (me === 200) return true
    }
  }
  return false
}
const loggedIn = await login()
if (!loggedIn) { console.log(JSON.stringify({ ok: false, step: 'login' })); process.exit(1) }

const checks = [
  ['overview', '/overview', `document.querySelectorAll('#layers > *').length > 0`, () => ev(`({
      title: document.title,
      layers: document.querySelectorAll('#layers > *').length,
      usage: document.querySelector('#usage')?.textContent ?? null,
      driver: document.querySelector('#driver')?.textContent?.trim() ?? null,
    })`)],
  ['artifacts', '/artifacts', `document.querySelector('#count')?.textContent !== '-'`, () => ev(`({
      title: document.title,
      count: document.querySelector('#count')?.textContent ?? null,
      rows: document.querySelectorAll('#list > *').length,
    })`)],
  ['settings', '/settings', `document.querySelectorAll('.set-key').length > 3`, () => ev(`({
      title: document.title,
      rows: document.querySelectorAll('.set-key').length,
    })`)],
  ['workbench', '/', `document.querySelectorAll('#sessions li').length > 0`, () => ev(`({
      title: document.title,
      sessions: document.querySelectorAll('#sessions li').length,
      sid: new URL(location.href).searchParams.get('sid'),
    })`)],
]

const results = {}
for (const [name, path, ready, read] of checks) {
  let ok = false
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    await raw('Page.navigate', { url: BASE + path }, 40000).catch(() => {})
    ok = await until(ready, 20000)
  }
  results[name] = { ok, ...(await read().catch(() => ({}))) }
}
console.log(JSON.stringify(results, null, 1))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1)
