#!/usr/bin/env node
// 点击劫持复现：用 iframe 嵌审批页，浏览器必须拒绝渲染；同时用"顶层直接打开"做对照。
// 用法：CK=<cookie> VICTIM=http://127.0.0.1:8787/ node scripts/cdp-frame-check.mjs
// 依赖已开启 --remote-debugging-port=9222 的 Chromium。
// 点击劫持复现：攻击者页面用 iframe 嵌入审批页，浏览器应拒绝渲染
const VICTIM = process.env.VICTIM ?? 'http://127.0.0.1:8787/'
const CK = process.env.CK
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map(); const logs = []
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Log.entryAdded') logs.push(`${m.params?.entry?.level}: ${String(m.params?.entry?.text ?? '').slice(0, 160)}`)
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true })).result?.value
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Log.enable'); await raw('Network.enable')
if (CK) await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
const attacker = `<!doctype html><meta charset="utf-8"><h1>攻击者页面</h1><iframe id="victim" src="${VICTIM}" width="900" height="500"></iframe>`
await raw('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(attacker) }, 20000)
await new Promise((r) => setTimeout(r, 3000))
let framed = 'unknown'
try {
  framed = await ev(`(() => { const f = document.querySelector('#victim'); try { return f.contentDocument ? '可访问（说明被渲染）' : '不可访问' } catch (e) { return '跨源不可访问（正常）' } })()`)
} catch (e) { framed = '检测失败: ' + e.message }
console.log('iframe 嵌入结果:', framed)
// 对照：同一个 URL 作为顶层页面能否正常打开（排除"页面本身坏了"）
await raw('Page.navigate', { url: VICTIM }, 20000)
await new Promise((r) => setTimeout(r, 2000))
console.log('对照（顶层直接打开）:', JSON.stringify(await ev(`({ title: document.title, statusbar: !!document.querySelector('.statusbar') })`)))
const browserLogs = logs.filter((l) => /frame|refused|x-frame|content security/i.test(l))
console.log('浏览器日志:', JSON.stringify(browserLogs))
// 结论：iframe 必须被拒（不可访问/被拦截），且"顶层直接打开"必须正常——否则说明是页面坏了，不是防住了
const top = await ev(`({ title: document.title, statusbar: !!document.querySelector('.statusbar') })`)
const blocked = /不可访问|拒绝|blocked|检测失败/.test(String(framed))
const ok = blocked && top?.statusbar === true
console.log(JSON.stringify({ framed, topOk: top?.statusbar === true, verdict: { blocked, ok } }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
