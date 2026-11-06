#!/usr/bin/env node
// 浏览器级验证：同一 run 只订阅一次 → 助手文本不重复、产物卡只有一张。
// 场景与 v177 的重复订阅一致：页面刚打开就提交（loadActive 与 send 会抢着订阅同一 run）。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'nodup-'))
const MOCK_PORT = 8851, APP_PORT = 8852
const UNIQUE = '唯一文本-MARKER-7f3a'

const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const msgs = (() => { try { return JSON.parse(body).messages ?? [] } catch { return [] } })()
    const hasTool = msgs.some((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (!hasTool) {
      res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.write', arguments: JSON.stringify({ path: 'report.md', content: '# ok' }) } }] } }] }))
    } else {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: UNIQUE }, finish_reason: 'stop' }] }))
    }
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env,
    APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    MODEL_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, MODEL_NAME: 'mock', MODEL_API_KEY: 'sk-mock',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
  },
  stdio: 'ignore',
})
const cleanup = () => { try { app.kill('SIGKILL') } catch {}; try { mock.close() } catch {} }
process.on('exit', cleanup)
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {}
}

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '去重验证' }) })).json()

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
await raw('Runtime.enable'); await raw('Page.enable')
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid}&token=tok_a` }, 25000)
for (let i = 0; i < 25; i++) { if (await ev(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(200) }
// 立刻提交：制造 loadActive 与 send 抢订阅的时序
await ev(`(() => {
  document.querySelector('#input').value = '写一份报告'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return true
})()`)

// 等审批卡并批准
for (let i = 0; i < 30; i++) {
  if (await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '允许一次')`).catch(() => false)) break
  await sleep(300)
}
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='允许一次'); b?.click(); return !!b })()`)

// 等完成
let info = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  info = await ev(`({
    occurrences: (document.body.textContent.match(/${UNIQUE}/g) || []).length,
    streamArtifacts: document.querySelectorAll('.stream-inner .artifact').length,
    panelArtifacts: document.querySelectorAll('#artifacts .artifact').length,
    status: document.querySelector('#runlabel')?.textContent ?? null,
  })`)
  if (info.occurrences > 0 && info.status && !String(info.status).includes('执行中')) break
}
// 事件流里应只有 1 张产物卡；右侧面板另有一份是"会话产物还原"，属预期
const ok = info && info.occurrences === 1 && info.streamArtifacts === 1 && info.panelArtifacts === 1
console.log(JSON.stringify({ ...info, ok }))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
cleanup()
process.exit(ok ? 0 : 1)
