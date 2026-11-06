import test from 'node:test'
import assert from 'node:assert/strict'

test('/api/usage 汇总租户内 token 与运行数（按天窗口）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { authorization: 'Bearer tok_a' }

  const now = new Date().toISOString()
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)').run('r_u1', 'done', now, 't_a', 's_a1')
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)').run('r_u2', 'done', now, 't_a', 's_a1')
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)').run('r_ub', 'done', now, 't_b', 's_b1')
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)')
    .run('r_u1', 1, 'run.finished', JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }), now)
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)')
    .run('r_u2', 1, 'run.finished', JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }), now)
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)')
    .run('r_ub', 1, 'run.finished', JSON.stringify({ usage: { prompt_tokens: 99, completion_tokens: 99, total_tokens: 198 } }), now)

  const r = await fetch(`${base}/api/usage?days=7`, { headers: H })
  assert.equal(r.status, 200)
  const u = await r.json()
  assert.equal(u.days, 7)
  assert.equal(u.runs, 2, '只统计本租户')
  assert.deepEqual(u.tokens, { prompt: 15, completion: 5, total: 20 })

  // 窗口收窄到 1 天仍然包含（数据是 now）
  const r1 = await (await fetch(`${base}/api/usage?days=1`, { headers: H })).json()
  assert.equal(r1.tokens.total, 20)

  assert.equal((await fetch(`${base}/api/usage`)).status, 401, '未登录 401')
})
