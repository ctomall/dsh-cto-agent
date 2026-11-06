import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t, env = {}) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('刷新页面能取回待审批：返回 runId / 工具 / 目标 / 参数', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '待审批还原' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))

  const r = await fetch(`${base}/api/sessions/${sid}/pending`, { headers: H })
  assert.equal(r.status, 200)
  const { pending } = await r.json()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].runId, runId)
  assert.equal(pending[0].tool, 'fs.write')
  assert.ok(pending[0].target.includes('report.md'))
  assert.equal(typeof pending[0].args, 'object')
})

test('审批后待审批列表清空', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '清空' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  const { pending } = await (await fetch(`${base}/api/sessions/${sid}/pending`, { headers: H })).json()
  assert.equal(pending.length, 0)
})

test('跨租户取待审批 → 404', async (t) => {
  const { base } = await boot(t)
  const r = await fetch(`${base}/api/sessions/s_b1/pending`, { headers: H })
  assert.equal(r.status, 404)
})
