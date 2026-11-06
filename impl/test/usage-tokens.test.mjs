import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'
import { AgentLoop } from '../src/loop.mjs'

test('流式 usage 被捕获并累加到 run.finished', async (t) => {
  const srv = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  t.after(() => srv.close())

  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' })
  const events = []
  const seen = []
  let status = 'running'
  const rc = { create() {}, transition(_i, to) { status = to }, status: () => status, emitTo(_i, ty, p) { events.push({ ty, p }) } }
  const tools = { schema: [], policy: {}, run: async () => ({ content: 'ok' }) }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: '/tmp', onUsage: (u) => seen.push(u) })
  const out = await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'x' })

  assert.equal(out.status, 'done')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].total_tokens, 12)
  const fin = events.find((e) => e.ty === 'run.finished')
  assert.deepEqual(fin.p.usage, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 })
})

test('多步调用时 usage 累加', async () => {
  const driverCalls = [
    { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'a.md', content: 'x' } }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { type: 'final', text: 'ok', usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } },
  ]
  let i = 0
  const driver = { name: 'd', complete: async () => driverCalls[i++] }
  const events = []
  let status = 'running'
  const rc = { create() {}, transition(_i, to) { status = to }, status: () => status, emitTo(_i, ty, p) { events.push({ ty, p }) } }
  const tools = { schema: [{ name: 'fs.write', description: 'w', parameters: {} }], policy: { 'fs.write': 'auto' }, run: async () => ({ content: 'ok', artifact: null }) }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: '/tmp' })
  await loop.start({ runId: 'r2', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  const fin = events.find((e) => e.ty === 'run.finished')
  assert.deepEqual(fin.p.usage, { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 })
})
