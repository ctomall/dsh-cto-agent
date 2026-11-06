#!/usr/bin/env node
// 公网页面全链路（不含真实模型）：登录 → 输入目标 → 审批卡 → 点「允许一次」→ 产物卡
// 目的：把「公网页面能否完成 输入→审批→产出」这段先验证掉，剩下的未知就只有"模型决策"。
// 用法：PW=<访问口令> BASE=https://cto.ila3.top node scripts/cdp-public-flow.mjs
const PW = process.env.PW, BASE = process.env.BASE || 'https://cto.ila3.top'
if (!PW) { console.error('需要 PW'); process.exit(2) }

const CDP = 'http://127.0.0.1:9222'
let tab
for (let attempt = 0; attempt < 3 && !tab; attempt++) {
  tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null)
}
if (!tab) { console.error('无法创建 CDP 目标'); process.exit(2) }
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 30000) =>
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
async function until(expr, label, ms = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await ev(expr).catch(() => false)) return true
    await sleep(500)
  }
  throw new Error('等待超时：' + label)
}
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')

// 1) 登录
await raw('Page.navigate', { url: `${BASE}/login` }, 40000)
await until(`!!document.querySelector('input[name=password]')`, '登录页')
await ev(`(() => { const i=document.querySelector('input[name=password]'); i.value=${JSON.stringify(PW)}; document.querySelector('form').submit(); return true })()`)
await until(`location.pathname === '/' && !!document.querySelector('#input')`, '登录成功进入工作台', 60000)
console.log('登录成功')

// 2) 输入目标并发送（Enter）
// 直接派发 form submit：比模拟 Enter 更稳定（keydown 监听在 #input 上，依赖焦点状态）
await ev(`(() => {
  const t = document.querySelector('#input')
  t.value = '写一份公网链路验证报告'
  t.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return t.value
})()`)
await sleep(1500)
console.log('已发送；当前状态栏:', await ev(`document.querySelector('#status')?.textContent ?? '(无)'`).catch(() => '(无)'))

// 3) 等审批卡并点「允许一次」
await until(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '允许一次')`, '审批卡出现', 60000)
console.log('审批卡已出现')
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='允许一次'); b.click(); return true })()`)

// 4) 等产物卡
await until(`document.querySelectorAll('.artifact').length > 0`, '产物卡出现', 60000)
const out = await ev(`({
  artifacts: document.querySelectorAll('.artifact').length,
  artifactName: document.querySelector('.artifact .nm')?.textContent ?? null,
  decided: document.body.textContent.includes('已允许一次'),
  finished: document.body.textContent.includes('完成') || document.body.textContent.includes('done'),
  title: document.title,
})`)
console.log(JSON.stringify(out))
const shot = await raw('Page.captureScreenshot', { format: 'png' }, 30000)
;(await import('node:fs')).writeFileSync('/tmp/public-flow.png', Buffer.from(shot.data, 'base64'))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
