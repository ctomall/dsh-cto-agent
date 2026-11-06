import test from 'node:test'
import assert from 'node:assert/strict'

test('探针单独限流：默认 5/分，第 6 次 429（每次都会真调模型，必须防烧钱）', async (t) => {
  process.env.RATE_PROBE_LIMIT = '2'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RATE_PROBE_LIMIT })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { authorization: 'Bearer tok_a' }

  const codes = []
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/model/probe`, { method: 'POST', headers: H })
    codes.push(r.status)
  }
  // 桩驱动：前两次 400 driver_is_stub（真实请求被限流器放行），第三次 429
  assert.deepEqual(codes.slice(0, 2), [400, 400], `前两次应为 400，实际 ${codes}`)
  assert.equal(codes[2], 429, `第三次应被限流，实际 ${codes}`)
})
