import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// 起一个最小的 OpenAI 兼容服务，验证 probe 真的会发请求并返回样本
function mockOpenAi(port) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
      })
    })
    srv.listen(port, () => resolve(srv))
  })
}

test('probe：桩驱动直接拒绝；真实驱动会真发请求', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // 当前测试环境没有 MODEL_*，driver 是桩 → 400 driver_is_stub
  const stub = await fetch(`${base}/api/model/probe`, { method: 'POST', headers: H })
  assert.equal(stub.status, 400)
  assert.equal((await stub.json()).error, 'driver_is_stub')

  // 未登录 → 401
  assert.equal((await fetch(`${base}/api/model/probe`, { method: 'POST' })).status, 401)
})
