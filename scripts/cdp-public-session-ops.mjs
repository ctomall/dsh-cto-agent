#!/usr/bin/env node
// 公网 Cookie 模式下验证会话管理三件事：筛选 / 重命名 / 两段删除。
// 用法：PW=<口令> [BASE=https://cto.ila3.top] node scripts/cdp-public-session-ops.mjs
const PW = process.env.PW, BASE = process.env.BASE || 'https://cto.ila3.top'
if (!PW) { console.error('需要 PW'); process.exit(2) }
const UNIQUE = `公网会话操作-${Date.now()}`

const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 40000) => Promise.race([
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
async function until(expr, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(400) }
  return false
}
await raw('Runtime.enable'); await raw('Page.enable')

// 登录（失败重试：公网丢包 + 登录限流）
let loggedIn = false
for (let i = 0; i < 3 && !loggedIn; i++) {
  await raw('Page.navigate', { url: `${BASE}/login` }, 40000).catch(() => {})
  if (!(await until(`!!document.querySelector('input[name=password]')`, 15000))) continue
  await ev(`(() => { const i=document.querySelector('input[name=password]'); i.value=${JSON.stringify(PW)}; document.querySelector('form').submit(); return true })()`)
  loggedIn = await until(`location.pathname === '/'`, 20000)
  if (loggedIn) loggedIn = (await ev(`fetch('/api/me').then(r=>r.status)`)) === 200
}
if (!loggedIn) { console.log(JSON.stringify({ ok: false, step: 'login' })); process.exit(1) }

// 准备一个唯一标题的会话（走接口，避免干扰 UI 状态）
const created = await ev(`fetch('/api/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ title: ${JSON.stringify(UNIQUE)} }) }).then(r=>r.json())`)
if (!created?.id) { console.log(JSON.stringify({ ok: false, step: 'create', created })); process.exit(1) }

// 刷新列表（页面重载后重新拉取会话）
await raw('Page.navigate', { url: `${BASE}/` }, 40000)
// 关键：等列表"稳定"（连续两次行数相同）——boot 会多次重绘，太早操作会被下一轮渲染覆盖
{
  let prev = -1, stable = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    const n = await ev(`document.querySelectorAll('#sessions li').length`).catch(() => 0)
    if (n > 0 && n === prev) { stable += 1; if (stable >= 2) break } else stable = 0
    prev = n
    await sleep(700)
  }
}

// 1) 筛选
await ev(`(() => { const b=document.querySelector('#session-filter'); b.value=${JSON.stringify(UNIQUE)}; b.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
const filtered = await ev(`({
  visible: [...document.querySelectorAll('#sessions li')].filter(l => !l.hidden).length,
  count: document.querySelector('#session-count')?.textContent ?? null,
})`)

// 2) 重命名：双击标题 → 输入 → Enter
const renamed = UNIQUE + '-已改名'
await ev(`(() => {
  const li = [...document.querySelectorAll('#sessions li')].find(l => l.textContent.includes(${JSON.stringify(UNIQUE)}))
  if (!li) return false
  li.querySelector('.row-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return true
})()`)
await sleep(300)
const renameOk = await ev(`(() => {
  const box = document.querySelector('#sessions input')
  if (!box) return false
  box.value = ${JSON.stringify(renamed)}
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)
await sleep(1200)
const renameApplied = await ev(`[...document.querySelectorAll('#sessions li')].some(l => l.textContent.includes('已改名'))`)

// 3) 两段删除
const delOk = await ev(`(() => {
  const li = [...document.querySelectorAll('#sessions li')].find(l => l.textContent.includes('已改名'))
  if (!li) return false
  const b = li.querySelector('.row-del')
  b.click(); b.click()
  return true
})()`)
await sleep(1500)
const gone = await ev(`![...document.querySelectorAll('#sessions li')].some(l => l.textContent.includes('已改名'))`)
const apiGone = await ev(`fetch('/api/sessions/${created.id}').then(r=>r.status)`)

const out = {
  filterVisible: filtered?.visible, filterCount: filtered?.count,
  renameClicked: renameOk, renameApplied, deleteClicked: delOk, rowGone: gone, apiStatus: apiGone,
}
out.ok = out.filterVisible === 1 && out.renameApplied && out.rowGone && out.apiStatus === 404
console.log(JSON.stringify(out))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
process.exit(out.ok ? 0 : 1)
