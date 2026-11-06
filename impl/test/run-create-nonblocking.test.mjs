import test from 'node:test'
import assert from 'node:assert/strict'

// 真模型单步可能几十秒：创建 run 的请求不能等 loop 跑完，必须立即 202。
test('创建 run 立即返回 202（不等模型第一步），run.started 仍会产生', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const t0 = Date.now()
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: 's_a1' }) })
  const ms = Date.now() - t0
  assert.equal(r.status, 202)
  const { runId } = await r.json()
  assert.ok(runId, '必须马上给出 runId 供订阅')
  assert.ok(ms < 1500, `创建请求应很快返回，实际 ${ms}ms`)

  // 后台仍会跑：给一点时间后应能看到 run.started 事件
  let seen = false
  for (let i = 0; i < 40; i++) {
    const ev = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
    if (ev.includes('event: run.started')) { seen = true; break }
    await new Promise((res) => setTimeout(res, 100))
  }
  assert.ok(seen, '后台执行应产生 run.started')
})
