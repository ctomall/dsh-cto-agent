import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'
import { AgentLoop } from '../src/loop.mjs'

function sseServer(port, chunks) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    srv.listen(port, () => resolve(srv))
  })
}

test('流式分片重组：参数被切成很多块（含键名中间断开）也能拼出完整 JSON', async (t) => {
  const port = 8793
  const srv = await sseServer(port, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'fs.write', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.md","content":"hi"}' } }] } }] },
  ])
  t.after(() => srv.close())
  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
  assert.equal(out.type, 'tool_call')
  assert.equal(out.call.name, 'fs.write')
  assert.deepEqual(out.call.args, { path: 'a.md', content: 'hi' })
})

test('并行 tool_call：第一个执行，其余显式回报 unsupported（不静默丢弃）', async (t) => {
  const port = 8794
  const srv = await sseServer(port, [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_1', function: { name: 'fs.write', arguments: '{"path":"a.md","content":"x"}' } },
      { index: 1, id: 'call_2', function: { name: 'fs.write', arguments: '{"path":"b.md","content":"y"}' } },
    ] } }] },
  ])
  t.after(() => srv.close())

  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' })
  const events = []
  let status = 'running'
  const rc = { create() {}, transition(_i, to) { status = to }, status: () => status, emitTo(_i, ty, p) { events.push({ ty, p }) } }
  const tools = {
    schema: [{ name: 'fs.write', description: 'w', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': 'auto' },
    run: async () => ({ content: 'ok', artifact: null }),
  }
  let calls = 0
  const base = driver.complete.bind(driver)
  const counted = { name: driver.name, complete: async (a) => { calls += 1; return calls === 1 ? base(a) : { type: 'final', text: 'done' } } }
  const messages = []
  const loop = new AgentLoop({ rc, tools, driver: counted, workspaceRoot: '/tmp', store: null })
  await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  const extra = events.find((e) => e.ty === 'tool.finished' && e.p.callId === 'call_2')
  assert.ok(extra, '第二个调用必须有事件')
  assert.equal(extra.p.error, 'parallel_tool_calls_unsupported')
  const primary = events.find((e) => e.ty === 'tool.finished' && e.p.callId === 'call_1')
  assert.equal(primary?.p.ok, true, '第一个调用应正常执行')
})
