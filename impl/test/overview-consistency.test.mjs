import test from 'node:test'
import assert from 'node:assert/strict'

// 总览是聚合视图：每个数字都必须能对上明细查询（v117 手工对过一次账，这里固化成用例）
test('总览 API 与库内直查同口径', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // 造三种终态：done（批准）、canceled（取消）、waiting（挂起不动）
  const mk = async (title) => (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title }) })).json()).id
  const runIn = async (sid, text = '写一份报告') => (await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: text, sessionId: sid }) })).json()).runId

  const s1 = await mk('done-1'); const r1 = await runIn(s1)
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${r1}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 300))

  const s2 = await mk('cancel-1'); const r2 = await runIn(s2)
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/runs/${r2}/cancel`, { method: 'POST', headers: H })
  await new Promise((r) => setTimeout(r, 200))

  const s3 = await mk('wait-1'); await runIn(s3)
  await new Promise((r) => setTimeout(r, 200))

  // failed 直接入库（应用侧没有"制造失败"的公开入口）
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_failed_seed', 'failed', new Date().toISOString(), 't_a', s1)

  const ov = await (await fetch(`${base}/api/overview`, { headers: H })).json()
  const one = (sql, ...args) => db.prepare(sql).get(...args).c

  assert.equal(ov.counts.sessions, one("select count(*) c from sessions where tenant_id='t_a'"), 'sessions')
  assert.equal(ov.counts.messages, one("select count(*) c from messages where tenant_id='t_a'"), 'messages')
  assert.equal(ov.counts.audit, one("select count(*) c from audit_log where tenant_id='t_a'"), 'audit')
  assert.equal(ov.counts.grants, one("select count(*) c from session_grants where tenant_id='t_a'"), 'grants')

  for (const st of ['done', 'canceled', 'failed', 'waiting_approval']) {
    const want = one("select count(*) c from runs where tenant_id='t_a' and status=?", st)
    assert.equal(ov.counts.runs[st] ?? 0, want, `runs.${st}`)
  }
  const total = one("select count(*) c from runs where tenant_id='t_a'")
  assert.equal(ov.counts.runsTotal, total, 'runsTotal')

  const waiting = one("select count(*) c from runs where tenant_id='t_a' and status='waiting_approval'")
  assert.equal(ov.pending.length, Math.min(waiting, 5), 'pending 与 waiting 数一致（最多 5 条）')
  assert.ok(ov.audit.length <= 8, 'audit 摘要最多 8 条')
})
