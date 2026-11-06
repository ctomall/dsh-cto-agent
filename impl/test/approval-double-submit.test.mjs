import test from 'node:test'
import assert from 'node:assert/strict'

// 双击"允许一次"/两个客户端同时批准：只能执行一次工具，不能产生两份产物。
test('并发审批同一个 run：工具只执行一次，产物只有一份', async (t) => {
  process.env.RUN_CREATE_WAIT_MS = '8000'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RUN_CREATE_WAIT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '并发审批' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()

  // 同时发 5 个批准请求
  const results = await Promise.all(
    Array.from({ length: 5 }, () => fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })),
  )
  const codes = results.map((r) => r.status)
  assert.ok(codes.every((c) => c === 200 || c === 409 || c === 404), `意外的响应码：${codes}`)

  // 等 run 收敛
  for (let i = 0; i < 40; i++) {
    const txt = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
    if (txt.includes('run.finished') || txt.includes('run.failed')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const txt = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
  const artifactCount = (txt.match(/event: artifact\.created/g) ?? []).length
  const toolFinished = (txt.match(/event: tool\.finished/g) ?? []).length
  assert.equal(artifactCount, 1, `产物事件应恰好 1 条，实际 ${artifactCount}：${txt.match(/event: [a-z.]+/g)?.join(' ')}`)
  assert.equal(toolFinished, 1, `工具执行应恰好 1 次，实际 ${toolFinished}`)
})
