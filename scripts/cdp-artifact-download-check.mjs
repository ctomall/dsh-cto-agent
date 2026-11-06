#!/usr/bin/env node
// 浏览器级验证：html 产物即使带 inline=1 也只能"下载"，不能被渲染成页面。
// 判据：导航后出现 downloadWillBegin，且页面标题没有被产物脚本改写。
// 用法：CK=<cookie> URL=<产物 URL> node scripts/cdp-artifact-download-check.mjs
const CK = process.env.CK, URL_ = process.env.URL, BASE = 'http://127.0.0.1:8787'
if (!CK || !URL_) { console.error('需要 CK 与 URL 环境变量'); process.exit(2) }

const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const events = []
const raw = (m, p = {}, ms = 15000) =>
  Promise.race([
    new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms)),
  ])
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id); pend.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    return
  }
  if (m.method) events.push(m)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/cdp-downloads' }).catch(() => {})
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })

// 先在一个正常页面里打开，再"点击"产物链接，模拟用户操作
await raw('Page.navigate', { url: BASE + '/' }, 20000)
await sleep(1200)
const beforeTitle = await ev('document.title')

await raw('Page.navigate', { url: URL_, timeout: 8000 }, 12000).catch(() => {})
await sleep(1500)

const downloads = events.filter((e) => /downloadWillBegin|downloadProgress/.test(e.method))
const afterTitle = await ev('document.title').catch(() => null)
const scriptRan = String(afterTitle ?? '').includes('XSS-RAN')

console.log(JSON.stringify({
  beforeTitle,
  afterTitle,
  downloadEvents: downloads.length,
  xssTitle: scriptRan,
  ok: downloads.length > 0 && !scriptRan,
}))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
