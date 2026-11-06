#!/usr/bin/env node
// 流式分片的渐进渲染：模型分多片返回时，界面应在过程中就看到文字增长，
// 而不是等全部结束才一次性出现（真模型（尤其推理型）常分片很慢）。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'stream-'))
const MOCK_PORT = 8941, APP_PORT = 8942
const PIECES = ['逐', '片', '渲', '染', '的', '文', '本', '到', '齐', '了']
const PER_MS = 400

const mock = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let i = 0
    const timer = setInterval(() => {
      if (i < PIECES.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: PIECES[i++] } }] })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } })}\n\n`)
        res.end('data: [DONE]\n\n')
        clearInterval(timer)
      }
    }, PER_MS)
    res.on('close', () => clearInterval(timer))
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

const app = spawn(process.execPath, ['impl/src/server.mjs'], {
  env: {
    ...process.env, APP_PASSWORD: '', APP_SESSION_SECRET: '',
    CUBE_TOKENS: '{"tok_a":{"tenantId":"t_a","userId":"u_a"}}',
    MODEL_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, MODEL_NAME: 'stream', MODEL_API_KEY: 'sk-s',
    PORT: String(APP_PORT), DB_PATH: join(work, 'cube.db'), WORKSPACE_ROOT: join(work, 'ws'),
  },
  stdio: 'ignore',
})
const cleanup = () => { try { app.kill('SIGKILL') } catch {}; try { mock.close() } catch {} }
process.on('exit', cleanup)
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/healthz`)).ok) break } catch {} }

const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
const { id: sid } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '流式' }) })).json()
const { runId } = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '随便说点什么', sessionId: sid }) })).json()

// 服务端事件层面：text.delta 应逐步出现
const seen = []
for (let i = 0; i < 80; i++) {
  const txt = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
  const n = (txt.match(/event: text\.delta/g) ?? []).length
  if (seen.at(-1) !== n) seen.push(n)
  if (txt.includes('run.finished')) break
  await new Promise((r) => setTimeout(r, 300))
}
// 服务端次数应"逐步增长"，不是 0→一次性全满
const grew = seen.filter((n) => n > 0)
const progressive = grew.length >= 3 && grew[grew.length - 1] >= PIECES.length - 1
const total = (seen.length ? seen[seen.length - 1] : 0)

// 用户可见层面：界面上的文字要在过程中"变长"，而不是最后一次性出现
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let cid = 0; const pend = new Map()
const raw = (m, p = {}, ms = 40000) => Promise.race([new Promise((res, rej) => { const i = ++cid; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + m)), ms))])
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const ev2 = async (x) => (await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await raw('Runtime.enable'); await raw('Page.enable')
const sid2 = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '流式UI' }) })).json()).id
await raw('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?sid=${sid2}&token=tok_a` }, 25000)
for (let i = 0; i < 40; i++) { if (await ev2(`!!document.querySelector('#input')`).catch(() => false)) break; await sleep(300) }
await ev2(`(() => { document.querySelector('#input').value = '说点什么'
  document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true })()`)
const samples = []
for (let i = 0; i < 30; i++) {
  const len = await ev2(`(() => { const el = document.querySelector('.stream-inner'); return el ? el.textContent.length : 0 })()`).catch(() => 0)
  samples.push(len)
  if (samples.at(-1) >= PIECES.length && samples.length > 6) break
  await sleep(300)
}
const uniq = [...new Set(samples.filter((n) => n > 0))]
const uiGrew = uniq.length >= 3 && Math.max(...uniq) > Math.min(...uniq)

const ok = progressive && total >= PIECES.length - 1 && uiGrew
console.log(JSON.stringify({ ok, deltaEvents: total, observedSteps: seen.slice(-6), uiSamples: samples.slice(-6), uiGrew }))
await raw('Page.close', {}, 3000).catch(() => {})
ws.close()
cleanup()
process.exit(ok ? 0 : 1)
