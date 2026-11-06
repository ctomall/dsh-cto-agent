#!/usr/bin/env node
// 浏览器实测：刷新后审批卡还原 → 点「允许一次」→ 产出出现、状态完成。
// 用法：CK=<cookie> SID=<有 waiting_approval run 的会话> node scripts/cdp-pending-ui-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
// 浏览器实测：刷新后审批卡还原 → 点「允许一次」→ 产出出现、状态完成
const CK = process.env.CK, SID = process.env.SID, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(expr, label, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(400) }
  throw new Error('超时：' + label)
}
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: `${BASE}/?sid=${SID}` }, 25000)
await until(`!!document.querySelector('#input')`, '输入框')
const before = await ev(`({ approval: !!document.querySelector('.card.approval'), status: document.querySelector('#sbStatus')?.textContent })`)
await until(`!!document.querySelector('.card.approval')`, '刷新后审批卡')
const cardText = await ev(`document.querySelector('.card.approval').innerText.replace(/\\n/g,' | ').slice(0,90)`)
await ev(`document.querySelector('.card.approval .btn:nth-child(3)').click()`) // 允许一次
await until(`!!document.querySelector('.artifact, .card.artifact') || document.querySelector('#sbStatus')?.textContent?.includes('完成')`, '产出或完成', 25000)
const after = await ev(`({ artifact: !!document.querySelector('.artifact, .card.artifact'), status: document.querySelector('#sbStatus')?.textContent, approvals: document.querySelectorAll('.card.approval').length })`)
console.log(JSON.stringify({ before, cardText, after }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
