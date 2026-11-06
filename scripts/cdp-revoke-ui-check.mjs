#!/usr/bin/env node
// ② 的授权生命周期：允许 → 面板可见 → 撤销 → 面板清空 → 再次调用重新弹卡。
// 用法：CK=<cookie> SID=<新会话> node scripts/cdp-revoke-ui-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
// 撤销授权后的页面行为：面板回到「尚未授权」，下一次调用重新弹卡
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
const send = (text) => ev(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit(); return true })()`)
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: `${BASE}/?sid=${SID}` }, 25000)
await until(`!!document.querySelector('#input')`, '输入框')

// 1) 建立会话授权
await send('写一份报告')
await until(`!!document.querySelector('.card.approval')`, '审批卡')
await ev(`document.querySelector('.card.approval .btn:nth-child(2)').click()`) // 本会话允许
await until(`document.querySelector('#sbStatus')?.textContent?.includes('完成')`, '第一次完成')
const granted = await ev(`document.querySelector('#grants')?.innerText`)

// 2) 撤销
await ev(`document.querySelector('#openArtifactsTop').click()`)
await sleep(300)
await ev(`document.querySelector('#revoke').click()`)
await until(`document.querySelector('#grants')?.innerText?.includes('尚未授权')`, '面板回到未授权', 15000)
const afterRevoke = await ev(`document.querySelector('#grants')?.innerText`)

// 3) 再发一次：必须重新弹卡
const approvalsBefore = await ev(`document.querySelectorAll('.card.approval').length`)
await send('再写一份')
await until(`document.querySelectorAll('.card.approval').length > ${approvalsBefore}`, '重新弹卡', 25000)
const final = await ev(`({ approvals: document.querySelectorAll('.card.approval').length, status: document.querySelector('#sbStatus')?.textContent })`)
console.log(JSON.stringify({ granted, afterRevoke, approvalsBefore, final }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
