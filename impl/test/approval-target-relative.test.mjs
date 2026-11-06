import test from 'node:test'
import assert from 'node:assert/strict'

// 审批卡是人工决策点：目标应当是人能理解的相对路径，不该出现占位式"伪绝对路径"。
test('审批卡 target 用会话内相对路径，不含 /data/tenants 占位', async (t) => {
  process.env.RUN_CREATE_WAIT_MS = '8000'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RUN_CREATE_WAIT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'target' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()

  const txt = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
  // SSE 帧格式：event: <type>\ndata: <json>\n\n —— 取 approval.requested 后面那一行 data
  const lines = txt.split('\n')
  const idx = lines.findIndex((l) => l === 'event: approval.requested')
  assert.ok(idx >= 0, `未找到 approval.requested，事件流：${txt.slice(0, 200)}`)
  const payload = JSON.parse(String(lines[idx + 1]).replace(/^data: /, ''))
  assert.equal(payload.target, 'report.md', `target 应为相对路径，实际 ${payload.target}`)
  assert.ok(!String(payload.target).includes('/data/tenants'), 'target 不应出现占位绝对路径')
  await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: H, body: '{}' })
})
