import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// 「停止」是否真的把上游请求掐掉（关系到是否继续计费）。
// 做法：mock provider 记录连接是否在响应前被客户端断开。
test('取消后上游请求被中止（不只是本地忽略结果）', async (t) => {
  let abortedEarly = false
  let responded = false
  const slow = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const timer = setTimeout(() => {
        responded = true
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '晚到的回复' }, finish_reason: 'stop' }] }))
        }
      }, 3000)
      // 客户端断开（fetch abort）会触发 close
      res.on('close', () => {
        if (!responded) { abortedEarly = true; clearTimeout(timer) }
      })
    })
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
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '中止上游' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: 'hi', sessionId: sid }) })).json()

  await new Promise((r) => setTimeout(r, 500))   // 请求已发出
  await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: H, body: '{}' })
  await new Promise((r) => setTimeout(r, 800))   // 给 abort 传播时间

  assert.equal(responded, false, '取消发生在模型响应之前（前提条件）')
  assert.ok(abortedEarly, '取消后应中止上游请求，而不是等它跑完')
})
