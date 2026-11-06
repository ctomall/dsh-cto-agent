import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// 用户点"停止"时模型调用可能还没返回：取消后不该再写事件、状态不能被打回 running。
test('模型调用进行中取消：状态保持 canceled，且不再产生后续事件', async (t) => {
  const slow = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '迟到的回复' }, finish_reason: 'stop' }] }))
    }, 1500))
  })
  await new Promise((r) => slow.listen(0, r))
  t.after(() => slow.close())

  process.env.MODEL_BASE_URL = `http://127.0.0.1:${slow.address().port}/v1`
  process.env.MODEL_NAME = 'slow'
  process.env.MODEL_API_KEY = 'sk-test'
  process.env.RUN_CREATE_WAIT_MS = '0'

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    for (const k of ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY', 'RUN_CREATE_WAIT_MS']) delete process.env[k]
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '取消竞态' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: 'hi', sessionId: sid }) })).json()

  await new Promise((r) => setTimeout(r, 300)) // 让模型调用先发出去
  const c = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: H, body: '{}' })
  assert.equal(c.status, 200)

  // 等到"迟到的回复"本该到达之后，再看状态与事件
  await new Promise((r) => setTimeout(r, 2600))
  const status = db.prepare('select status from runs where id = ?').get(runId).status
  assert.equal(status, 'canceled', `取消后状态不应被改写，实际 ${status}`)

  const ev = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
  assert.ok(ev.includes('run.canceled'), '应有 canceled 事件')
  assert.ok(!ev.includes('run.finished'), '迟到的模型响应不应把 run 变成 finished')
  const lateText = (await (await fetch(`${base}/api/sessions/${sid}/messages`, { headers: H })).json()).messages.filter((m) => m.role === 'assistant')
  assert.equal(lateText.length, 0, '取消后不应落助手消息')
})
