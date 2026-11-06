import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'

// 推理型端点的字段名不统一：reasoning_content / reasoning / thinking。
// 统一要求：只计数、不进正文。
for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
  test(`流式：${field} 只计数不泄漏`, async (t) => {
    const mock = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { [field]: '思考中' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise((r) => mock.listen(0, r))
    t.after(() => mock.close())
    const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 10000 })
    const deltas = []
    const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (d) => deltas.push(d) })
    assert.equal(out.text, '好的')
    assert.deepEqual(deltas, ['好的'])
    assert.equal(out.reasoningChars, 3, `${field} 应被计数`)
  })
}

test('非流式：thinking 字段被计数但不进正文', async (t) => {
  const mock = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '答案', thinking: '想了五秒' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((r) => mock.listen(0, r))
  t.after(() => mock.close())
  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 10000 })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
  assert.equal(out.text, '答案')
  assert.equal(out.reasoningChars, 4)
})
