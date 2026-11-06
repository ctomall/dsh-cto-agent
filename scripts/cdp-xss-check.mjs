#!/usr/bin/env node
// 浏览器级 XSS 检查：会话标题里的 HTML/脚本载荷必须被当作纯文本渲染。
// 用法：CK=<cookie> TOK=<bearer> node scripts/cdp-xss-check.mjs
const CK = process.env.CK, TOK = process.env.TOK, BASE = 'http://127.0.0.1:8787'
if (!CK || !TOK) { console.error('需要 CK 与 TOK 环境变量'); process.exit(2) }

const PAYLOAD = `<img src=x onerror="document.title='XSS-ROW'"><script>document.title='XSS-SCRIPT'</script>`

// 1) 用接口建一个带载荷标题的会话（走 cookie + bearer，跟真实客户端一致）
const cookieHeader = `cube_session=${CK}`
const created = await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}`, cookie: cookieHeader },
  body: JSON.stringify({ title: PAYLOAD }),
})
if (!created.ok) { console.error('创建会话失败', created.status); process.exit(3) }
const { id: sid } = await created.json()

// 2) 在真实浏览器里打开首页，检查载荷没有被解析成节点
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 15000) =>
  Promise.race([
    new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms)),
  ])
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: BASE + '/' }, 25000)
await new Promise((r) => setTimeout(r, 2500))

const out = await ev(`({
  title: document.title,
  injectedImgs: document.querySelectorAll('#sessions img').length,
  injectedScripts: document.querySelectorAll('#sessions script').length,
  renderedAsText: [...document.querySelectorAll('#sessions li')].some(l => l.textContent.includes('onerror')),
})`)
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()

// 3) 清理测试会话
const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOK}`, cookie: cookieHeader } })
console.log(JSON.stringify({ ...out, deleted: del.status, ok: out.title === 'cube-agent' && out.injectedImgs === 0 && out.injectedScripts === 0 && out.renderedAsText }))
