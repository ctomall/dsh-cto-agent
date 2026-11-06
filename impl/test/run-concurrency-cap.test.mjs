import test from 'node:test'
import assert from 'node:assert/strict'

// 真模型下每条 running 的 run 都在花钱：必须有全局并发上限（默认 4，可用 AGENT_MAX_CONCURRENT 调）。
test('超过全局并发上限时拒绝创建 run（429 too_many_runs）', async (t) => {
  process.env.AGENT_MAX_CONCURRENT = '1'
  process.env.RUN_CREATE_WAIT_MS = '0'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    delete process.env.AGENT_MAX_CONCURRENT
    delete process.env.RUN_CREATE_WAIT_MS
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // 人造一条 running 的 run（占满上限）
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_occupy', 'running', new Date().toISOString(), 't_a', 's_a1')

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '并发上限' }) })).json()
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: 'hi', sessionId: sid }) })
  assert.equal(r.status, 429, `应被并发上限挡住，实际 ${r.status}`)
  const body = await r.json()
  assert.equal(body.error, 'too_many_runs')
  assert.equal(body.limit, 1)
  assert.ok(body.retryAfter > 0, '应给出 retryAfter，便于客户端退避')

  // 释放占用后应恢复可用
  db.prepare('update runs set status = ? where id = ?').run('done', 'r_occupy')
  const ok = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: 'hi', sessionId: sid }) })
  assert.equal(ok.status, 202, `释放后应可创建，实际 ${ok.status}`)
})
