import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'

// 推理型模型会先发 reasoning_content（思考过程），再发 content（答案）。
// 思考内容绝不能出现在用户可见的文本里；且只有思考、没有答案时要能正常结束。
test('reasoning_content 不会被当成回答文本；纯思考也能正常结束', async (t) => {
  const mock = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一下…' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '再想想…' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '答案是 42' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => mock.listen(0, r))
  t.after(() => mock.close())

  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 10000 })
  const deltas = []
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (d) => deltas.push(d) })
  assert.equal(out.type, 'final')
  assert.equal(out.text, '答案是 42', '回答里不能混入思考内容')
  assert.ok(!out.text.includes('想一下'), '绝不能泄漏 reasoning')
  assert.deepEqual(deltas, ['答案是 42'], '推给前端的增量也只能是答案')
})

test('只有思考、没有答案：正常结束且文本为空（不抛错）', async (t) => {
  const mock = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '只有思考' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => mock.listen(0, r))
  t.after(() => mock.close())
  const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 10000 })
  const out = await driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
  assert.equal(out.type, 'final')
  assert.equal(out.text, '')
})
