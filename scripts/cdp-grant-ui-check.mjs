#!/usr/bin/env node
// ② 的 UI 承诺实测：同会话第二次调用不再弹审批卡，改为「已按会话授权放行」；并校验每轮一个助手块。
// 用法：CK=<cookie> SID=<新会话 id> node scripts/cdp-grant-ui-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
// ② 的 UI 承诺实测：同会话第二次调用不再弹审批卡，而是显示「已按会话授权放行」
const CK = process.env.CK, SID = process.env.SID, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(expr, label, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(400) } throw new Error('超时：' + label) }
const send = async (text) => {
  await ev(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit(); return true })()`)
}
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: `${BASE}/?sid=${SID}` }, 25000)
await until(`!!document.querySelector('#input')`, '输入框')

// 第一次：应弹卡 → 点「本会话允许」
await send('写一份报告')
await until(`!!document.querySelector('.card.approval')`, '第一次审批卡')
const first = await ev(`({ approvals: document.querySelectorAll('.card.approval').length })`)
await ev(`document.querySelector('.card.approval .btn:nth-child(2)').click()`) // 本会话允许
await until(`document.querySelector('#sbStatus')?.textContent?.includes('完成')`, '第一次完成')

// 第二次：同会话同工具 → 不应再弹卡
const approvalsBefore = await ev(`document.querySelectorAll('.card.approval').length`)
await send('再写一份')
await until(`document.querySelector('#sbStatus')?.textContent?.includes('完成')`, '第二次完成', 30000)
const second = await ev(`({
  approvalsAfter: document.querySelectorAll('.card.approval').length,
  autoNotes: [...document.querySelectorAll('.note')].map(n => n.textContent.trim()),
  toolStates: [...document.querySelectorAll('.card.tool .state')].map(s => s.textContent.trim()),
  artifacts: document.querySelectorAll('.artifact, .card.artifact').length,
  assistantBlocks: [...document.querySelectorAll('.msg.assistant .text')].map(t => t.textContent.slice(0, 40)),
})`)
console.log(JSON.stringify({ first, approvalsBefore, second }, null, 0))
const s = await raw('Page.captureScreenshot', { format: 'png' }, 20000)
;(await import('node:fs')).writeFileSync('/tmp/grant-ui2.png', Buffer.from(s.data, 'base64'))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
