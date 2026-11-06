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

test('活动 run：返回 running/waiting_approval 及最后事件序号（刷新可续接）', async (t) => {
  const { base, db } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '续接' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))

  const { active } = await (await fetch(`${base}/api/sessions/${sid}/active`, { headers: H })).json()
  assert.equal(active.length, 1)
  assert.equal(active[0].runId, runId)
  assert.equal(active[0].status, 'waiting_approval')
  assert.ok(active[0].lastSeq > 0, 'lastSeq 用于订阅续接')

  // 结束态不进 active
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 300))
  const after = await (await fetch(`${base}/api/sessions/${sid}/active`, { headers: H })).json()
  assert.equal(after.active.length, 0)
})

test('活动 run：跨租户 404', async (t) => {
  const { base } = await boot(t)
  assert.equal((await fetch(`${base}/api/sessions/s_b1/active`, { headers: H })).status, 404)
})
