import test from 'node:test'
import assert from 'node:assert/strict'

// 同一会话只允许一条 running 的 run：多标签页/多设备同时提交时，第二个在源头上被拒。
test('会话已有 running 的 run 时，再创建返回 409 active_run', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const now = new Date().toISOString()

  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_busy', 'running', now, 't_a', 's_a1')

  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '再发一次', sessionId: 's_a1' }) })
  assert.equal(r.status, 409)
  const body = await r.json()
  assert.equal(body.error, 'active_run')
  assert.equal(body.runId, 'r_busy', '应告诉调用方在跑的是哪一条，便于接管')

  // 等待审批的 run 不算占用：一个会话允许多条待审批
  db.prepare('update runs set status = ? where id = ?').run('waiting_approval', 'r_busy')
  const r2 = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '审批可以并存', sessionId: 's_a1' }) })
  assert.equal(r2.status, 202, 'waiting_approval 不应阻止新 run')
})
