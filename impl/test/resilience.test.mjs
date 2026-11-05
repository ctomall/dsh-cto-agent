import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'
import { AgentLoop } from '../src/loop.mjs'

function hangingServer() {
  return createServer((req, res) => { /* 永不响应，模拟 provider 卡死 */ })
}

test('provider 卡死 → run 超时失败，不会永远停在 running', async (t) => {
  const srv = hangingServer()
  await new Promise((r) => srv.listen(0, r))
  t.after(() => { srv.closeAllConnections?.(); srv.close() })

  const events = []
  const states = []
  const rc = {
    create() {}, transition(_id, to) { states.push(to) }, emitTo(_id, type, payload) { events.push({ type, payload }) },
  }
  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'm' })
  const loop = new AgentLoop({ rc, tools: { schema: [], policy: {}, run: async () => ({}) }, driver, workspaceRoot: '/tmp', timeoutMs: 120 })
  const r = await loop.start({ runId: 'rt', tenantId: 't_a', sessionId: 's_a1', input: 'go' })
  assert.equal(r.status, 'failed')
  assert.deepEqual(states, ['running', 'failed'])
  const fail = events.find((e) => e.type === 'run.failed')
  assert.match(fail.payload.error, /timeout after 120ms/)
})

test('provider 503 两次后成功 → 自动重试成功', async (t) => {
  let calls = 0
  const srv = createServer((req, res) => {
    calls++
    if (calls <= 2) { res.writeHead(503); return res.end('busy') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  await new Promise((r) => srv.listen(0, r))
  t.after(() => srv.close())

  const d = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'm' })
  const out = await d.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
  assert.equal(out.text, 'ok')
  assert.equal(calls, 3, '应是 2 次失败 + 1 次成功')
})

test('provider 400 不重试（请求错重试无意义）', async (t) => {
  let calls = 0
  const srv = createServer((req, res) => { calls++; res.writeHead(400); res.end('bad') })
  await new Promise((r) => srv.listen(0, r))
  t.after(() => srv.close())

  const d = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'm' })
  await assert.rejects(() => d.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] }), /provider 400/)
  assert.equal(calls, 1)
})
