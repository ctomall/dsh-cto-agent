const CK = process.env.CK, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
// 设置页：连点探针直到 429，看文案
await raw('Page.navigate', { url: BASE + '/settings' }, 25000)
await sleep(2500)
let out = ''
for (let i = 0; i < 7; i++) {
  await ev(`(() => { const b = document.querySelector('#probe'); if (b && !b.disabled) b.click(); return true })()`)
  await sleep(600)
  out = await ev(`document.querySelector('#probe-out')?.textContent`)
  if (String(out).includes('频繁')) break
}
// 结论：限流必须告诉用户"还要等多久"，否则只能盲猜重试时间
const ok = /秒后再试|过于频繁/.test(String(out ?? '')) && /\d+/.test(String(out ?? ''))
console.log(JSON.stringify({ text: out, verdict: { ok } }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
