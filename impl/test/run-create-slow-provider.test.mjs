import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// 用"慢 provider"模拟真模型：创建请求必须立刻返回，run 在后台继续。
test('慢 provider 下创建 run 仍立即 202（不阻塞到模型返回）', async (t) => {
  const slow = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '慢回复' }, finish_reason: 'stop' }] }))
    }, 2500))
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
  t.after(() => { app.close(); delete process.env.MODEL_BASE_URL; delete process.env.MODEL_NAME; delete process.env.MODEL_API_KEY })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '慢' }) })).json()

  const t0 = Date.now()
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: 'hi', sessionId: sid }) })
  const ms = Date.now() - t0
  assert.equal(r.status, 202)
  assert.ok(ms < 1000, `创建请求不该等模型，实际 ${ms}ms`)

  // 后台仍在跑：稍后消息应落库
  const { runId } = await r.json()
  let done = false
  for (let i = 0; i < 60; i++) {
    const ev = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
    if (ev.includes('run.finished') || ev.includes('run.failed')) { done = true; break }
    await new Promise((res) => setTimeout(res, 150))
  }
  assert.ok(done, '后台 run 应自行跑完')
})
