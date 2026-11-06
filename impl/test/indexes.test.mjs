import test from 'node:test'
import assert from 'node:assert/strict'

test('热查询走索引而不是全表扫（runs 按会话/状态）', async (t) => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  t.after(() => db.close())

  const plan = (sql) => db.prepare(`explain query plan ${sql}`).all().map((r) => r.detail).join(' | ')
  const bySession = plan("select id from runs where tenant_id='t_a' and session_id='s_a1'")
  const byStatus = plan("select id from runs where status='waiting_approval'")
  assert.match(bySession, /SEARCH runs USING INDEX/, `按会话查 runs 应走索引，实际：${bySession}`)
  assert.match(byStatus, /SEARCH runs USING INDEX/, `按状态查 runs 应走索引，实际：${byStatus}`)

  const idx = db.prepare('pragma index_list(runs)').all().map((r) => r.name)
  assert.ok(idx.includes('idx_runs_session'), 'idx_runs_session 应存在')
  assert.ok(idx.includes('idx_runs_status'), 'idx_runs_status 应存在')
})

test('会话深链 /c/:sid → 302 到 /?sid=', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  const r = await fetch(`${base}/c/s_abc123`, { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/?sid=s_abc123')
})
