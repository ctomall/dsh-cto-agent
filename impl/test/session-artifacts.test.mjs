import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}` }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('会话产物列表：跑完一次后能列出产物，可跨刷新还原', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '产物还原' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 300))

  const r = await fetch(`${base}/api/sessions/${sid}/artifacts`, { headers: H })
  assert.equal(r.status, 200)
  const { artifacts } = await r.json()
  assert.ok(artifacts.length >= 1, '应至少有一个产物')
  assert.ok(artifacts[0].path.endsWith('report.md'))
  assert.equal(artifacts[0].runId, runId)
})

test('会话产物列表：跨租户 404', async (t) => {
  const { base } = await boot(t)
  assert.equal((await fetch(`${base}/api/sessions/s_b1/artifacts`, { headers: H })).status, 404)
})
