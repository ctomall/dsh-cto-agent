import test from 'node:test'
import assert from 'node:assert/strict'

// 事前标记"谁在驱动"：桩驱动的 run 不能被误当成真实模型产出
test('run.started 记录 driver 与 real 标记（桩驱动必须标明 real:false）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'driver 标记' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 400))

  const row = db.prepare("select payload_json from events where run_id = ? and type = 'run.started'").get(runId)
  assert.ok(row, '应有 run.started 事件')
  const payload = JSON.parse(row.payload_json)
  assert.ok(payload.driver, `必须记录 driver，实际：${row.payload_json}`)
  assert.equal(payload.real, false, '桩驱动必须标 real:false')
  assert.match(payload.driver, /^fake/, 'driver 名应以 fake 开头（测试环境无 MODEL_*）')
})
