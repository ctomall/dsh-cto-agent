const CK = process.env.CK, SID = process.env.SID, BASE = 'http://127.0.0.1:8787'
const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const raw = (m, p = {}, ms = 15000) => Promise.race([new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(expr, label, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(300) } throw new Error('超时：' + label) }
await raw('Runtime.enable'); await raw('Page.enable'); await raw('Network.enable')
await raw('Network.setCookie', { name: 'cube_session', value: CK, domain: '127.0.0.1', path: '/', httpOnly: true })
await raw('Page.navigate', { url: `${BASE}/?sid=${SID}` }, 25000)
await until(`!!document.querySelector('#sessions li')`, '会话列表')
const found = await ev(`[...document.querySelectorAll('#sessions li')].some(li => li.textContent.includes('UI删除验证'))`)
await ev(`(() => {
  const li = [...document.querySelectorAll('#sessions li')].find(li => li.textContent.includes('UI删除验证'));
  const btn = li.querySelector('.row-del');
  btn.click();            // 第一次：进入 armed
  window.__armed = btn.textContent;
  btn.click();            // 第二次：真正删除
  return true })()`)
await sleep(1200)
const after = await ev(`({ stillThere: [...document.querySelectorAll('#sessions li')].some(li => li.textContent.includes('UI删除验证')), armedText: window.__armed })`)
console.log(JSON.stringify({ found, after }))
await raw('Page.close', {}, 5000).catch(() => {}); ws.close()
