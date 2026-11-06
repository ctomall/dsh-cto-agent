#!/usr/bin/env node
// 浏览器级验证：超长参数被截断时，审批卡必须显示「参数较长，已截断显示」。
// 做法：起一个只会返回"写 5000 字"的 mock provider + 临时实例（无门禁），用 CDP 打开页面。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIG = 'A'.repeat(5000)
const work = mkdtempSync(join(tmpdir(), 'appr-trunc-'))
const MOCK_PORT = 8811, APP_PORT = 8812

const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const msgs = (() => { try { return JSON.parse(body).messages ?? [] } catch { return [] } })()
    const hasTool = msgs.some((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (!hasTool) {
      res.end(JSON.stringify({
        choices: [{ message: {
          role: 'assistant',
          tool_calls: [{ id: 'call_big', type: 'function', function: { name: 'fs.write', arguments: JSON.stringify({ path: 'big.md', content: BIG }) } }],
        } }],
      }))
    } else {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '写好了' }, finish_reason: 'stop' }] }))
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
const cleanup = () => { try { app.kill('SIGKILL') } catch {} ; try { mock.close() } catch {} }
process.on('exit', cleanup)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {}
}

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '截断验证' }) })).json()
const { runId } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写个大的', sessionId: sid }) })).json()
await new Promise((r) => setTimeout(r, 800))

// CDP：打开页面并检查审批卡
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
const raw = (m, p = {}, ms = 30000) => Promise.race([
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
for (let i = 0; i < 30; i++) { if (await ev(`document.querySelectorAll('.approval').length > 0`).catch(() => false)) break; await sleep(400) }
// 先看后端事件里到底有没有 argsTruncated
const evs = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
const line = evs.split('\n').find((l) => l.includes('argsTruncated')) ?? ''
console.log('事件里的 argsTruncated:', line ? '存在' : '缺失', '| 长度:', line.length)
const out = await ev(`({
  cards: document.querySelectorAll('.approval').length,
  bodyText: document.body.textContent.includes('参数较长，已截断显示'),
  preLen: [...document.querySelectorAll('.approval pre')].map(p => p.textContent.length)[0] ?? 0,
})`)
console.log(JSON.stringify({ ...out, ok: out.cards > 0 && out.bodyText }))
await raw('Page.close', {}, 5000).catch(() => {})
ws.close()
cleanup()
process.exit(out.cards > 0 && out.bodyText ? 0 : 1)
