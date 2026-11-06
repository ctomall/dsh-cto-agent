import test from 'node:test'
import assert from 'node:assert/strict'

// 租户矩阵：A 造出各种资源，B 逐个访问，必须一律 404（不区分越权与不存在）
test('资源 × 租户矩阵：B 访问 A 的所有资源都应 404', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const A = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const B = { 'content-type': 'application/json', authorization: 'Bearer tok_b' }

  // A 造资源：会话 → run（挂起）→ 批准 → 产物 + 授权
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ title: 'A 的资源' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: A, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: A, body: JSON.stringify({ decision: 'allow_session' }) })
  await new Promise((r) => setTimeout(r, 300))

  const paths = [
    `/api/sessions/${sid}`,
    `/api/sessions/${sid}/messages`,
    `/api/sessions/${sid}/pending`,
    `/api/sessions/${sid}/grants`,
    `/api/sessions/${sid}/artifacts`,
    `/api/sessions/${sid}/active`,
    `/api/runs/${runId}/events?replay=1`,
    `/api/artifacts/${runId}/report.md`,
  ]
  for (const p of paths) {
    const own = await fetch(base + p, { headers: A })
    assert.equal(own.status, 200, `A 应可访问 ${p}（实际 ${own.status}）`)
    const cross = await fetch(base + p, { headers: B })
    assert.equal(cross.status, 404, `B 访问 ${p} 应 404（实际 ${cross.status}）`)
  }

  // 变更类：B 也不能批 / 不能取消
  assert.equal((await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: B })).status, 404, 'B 取消 A 的 run 应 404')
  assert.equal((await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: B, body: JSON.stringify({ decision: 'allow_once' }) })).status, 404, 'B 批 A 的 run 应 404')
})
