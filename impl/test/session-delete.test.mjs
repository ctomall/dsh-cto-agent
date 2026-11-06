import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('删除会话：级联清理并写审计', async (t) => {
  const { base, db } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '待删除' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_session' }) })
  await new Promise((r) => setTimeout(r, 300))

  const r = await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE', headers: H })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.deleted, true)
  assert.ok(body.removed.runs >= 1)
  assert.ok(body.removed.events >= 1)

  assert.equal(db.prepare('select count(*) c from sessions where id = ?').get(sid).c, 0)
  assert.equal(db.prepare('select count(*) c from runs where session_id = ?').get(sid).c, 0)
  assert.equal(db.prepare('select count(*) c from messages where session_id = ?').get(sid).c, 0)
  assert.equal(db.prepare('select count(*) c from events where run_id = ?').get(runId).c, 0)
  assert.equal(db.prepare('select count(*) c from session_grants where session_id = ?').get(sid).c, 0)
  assert.equal(db.prepare("select count(*) c from audit_log where action = 'session_deleted'").get().c, 1)
})

test('删除会话：活动 run 时 409；跨租户 404', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '有活动 run' }) })).json()
  await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })
  await new Promise((r) => setTimeout(r, 200))

  const blocked = await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE', headers: H })
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).error, 'has_active_runs')

  const cross = await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE', headers: { authorization: 'Bearer tok_b' } })
  assert.equal(cross.status, 404)
  const still = await (await fetch(`${base}/api/sessions/${sid}`, { headers: H })).json()
  assert.equal(still.session?.id, sid, '跨租户删除不得生效')
})
