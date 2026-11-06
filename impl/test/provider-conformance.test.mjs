import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'

// 真实 provider 的常见"怪癖"：分片断在多字节字符中间、保活空块、429 后恢复、多字节内容
async function sseOnce(t, handler) {
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(res, body))
  })
  await new Promise((r) => srv.listen(0, r))
  t.after(() => srv.close())
  return { url: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port }
}

test('多字节字符被切在两个 chunk 中间，仍能正确解码', async (t) => {
  const { url } = await sseOnce(t, (res) => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好世界' } }] })}\n\n`
    const buf = Buffer.from(line, 'utf8')
    // 故意在 UTF-8 多字节序列中间切开
    const cut = buf.indexOf(Buffer.from('你')) + 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(buf.subarray(0, cut))
    setTimeout(() => { res.write(buf.subarray(cut)); res.end('data: [DONE]\n\n') }, 20)
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  let text = ''
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (d) => { text += d } })
  assert.equal(out.type, 'final')
  assert.equal(out.text, '你好世界')
  assert.equal(text, '你好世界')
})

test('保活空块（choices: []）不会破坏解析', async (t) => {
  const { url } = await sseOnce(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[]}\n\n')
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
  assert.equal(out.type, 'final')
  assert.equal(out.text, 'ok')
})

test('429 后重试成功（provider 限流）', async (t) => {
  let n = 0
  const { url } = await sseOnce(t, (res) => {
    n += 1
    if (n === 1) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"rate limited"}') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }] }))
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
  assert.equal(out.type, 'final')
  assert.equal(out.text, 'recovered')
  assert.equal(n, 2, '应重试一次')
})

test('4xx（非 429）不重试，直接抛出可读错误', async (t) => {
  let n = 0
  const { url } = await sseOnce(t, (res) => {
    n += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"bad request"}}')
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  await assert.rejects(() => driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] }), /provider 400/)
  assert.equal(n, 1, '4xx 不应重试')
})

test('tool_call 缺 id 时补默认 id，不产生 undefined', async (t) => {
  const { url } = await sseOnce(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'fs.write', arguments: '{"path":"a.md","content":"x"}' } }] } }] }))
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
  assert.equal(out.type, 'tool_call')
  assert.ok(out.call.id, `id 不能为空：${JSON.stringify(out.call)}`)
  assert.equal(out.call.name, 'fs.write')
})

test('finish_reason=length：run 标 truncated 并追加提示，不静默当成功', async (t) => {
  const { url } = await sseOnce(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '半截的答案' }, finish_reason: 'length' }] }))
  })
  const driver = createOpenAiDriver({ baseUrl: url, apiKey: 'k', model: 'm' })
  const events = []
  let status = 'running'
  const rc = { create() {}, transition(_i, to) { status = to }, status: () => status, emitTo(_i, ty, p) { events.push({ ty, p }) } }
  const { AgentLoop } = await import('../src/loop.mjs')
  const loop = new AgentLoop({ rc, tools: { schema: [], policy: {}, run: async () => ({}) }, driver, workspaceRoot: '/tmp' })
  const out = await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  assert.equal(out.status, 'done')
  const fin = events.find((e) => e.ty === 'run.finished')
  assert.equal(fin.p.truncated, true, 'run.finished 应带 truncated')
  const note = events.filter((e) => e.ty === 'text.delta').map((e) => e.p.text).join('')
  assert.match(note, /被截断/, '要给用户可见提示')
})
