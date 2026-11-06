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

test('审计可读：返回本租户动作与详情，倒序', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '审计' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 200))

  const r = await fetch(`${base}/api/audit?limit=20`, { headers: H })
  assert.equal(r.status, 200)
  const { audit } = await r.json()
  assert.ok(audit.length >= 1, '至少一条审计')
  assert.ok(audit.some((a) => a.action === 'approval_decided'), '审批动作应被记录')
  for (let i = 1; i < audit.length; i++) assert.ok(audit[i - 1].id > audit[i].id, '应按 id 倒序')
})

test('审计按租户隔离：B 看不到 A 的动作', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'A 的会话' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 200))

  const a = await (await fetch(`${base}/api/audit`, { headers: H })).json()
  assert.ok(a.audit.length >= 1)
  const b = await (await fetch(`${base}/api/audit`, { headers: { authorization: 'Bearer tok_b' } })).json()
  assert.equal(b.audit.length, 0, 'B 不应看到 A 的审计')
})
