import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'
import { AgentLoop } from '../src/loop.mjs'

function sseServer(chunks) {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
}

test('流式：逐块触发 onDelta，最终文本拼接正确', async (t) => {
  const srv = sseServer([
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { content: '，' } }] },
    { choices: [{ delta: { content: '世界' } }] },
  ])
  await new Promise((r) => srv.listen(0, r))
  t.after(() => srv.close())

  const deltas = []
  const d = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'm' })
  const out = await d.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (t) => deltas.push(t) })
  assert.deepEqual(deltas, ['你好', '，', '世界'])
  assert.equal(out.type, 'final')
  assert.equal(out.text, '你好，世界')
})

test('流式：tool_calls 分片能拼成完整调用', async (t) => {
  const srv = sseServer([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs.write', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md","content":"hi"}' } }] } }] },
  ])
  await new Promise((r) => srv.listen(0, r))
  t.after(() => srv.close())

  const d = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'm' })
  const out = await d.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
  assert.equal(out.type, 'tool_call')
  assert.equal(out.call.name, 'fs.write')
  assert.deepEqual(out.call.args, { path: 'a.md', content: 'hi' })
})

test('loop 流式时逐块发 text.delta，且不再整段重复', async () => {
  const events = []
  const rc = {
    create() {}, transition() {}, emitTo(_id, type, payload) { events.push({ type, payload }) },
  }
  const driver = {
    name: 'stream-spy',
    async complete({ onDelta }) {
      onDelta('A'); onDelta('B')
      return { type: 'final', text: 'AB' }
    },
  }
  const loop = new AgentLoop({ rc, tools: { schema: [], policy: {}, run: async () => ({}) }, driver, workspaceRoot: '/tmp' })
  await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'go' })
  const deltas = events.filter((e) => e.type === 'text.delta').map((e) => e.payload.text)
  assert.deepEqual(deltas, ['收到目标：go', 'A', 'B'], '流式增量已发，不应再补整段 AB')
})
