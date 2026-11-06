import test from 'node:test'
import assert from 'node:assert/strict'

// 服务层集成：模拟"工具已执行、产物事件未落库"的崩溃窗口——
// 预置 run_pending + run_tool_results(含 artifact)，批准后恢复时应当补发 artifact.created。
test('恢复时补发缺失的产物事件（服务层集成）', async (t) => {
  process.env.RUN_TRANSITION_WAIT_MS = '8000'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RUN_TRANSITION_WAIT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const now = new Date().toISOString()

  // 1) 真实创建一条 run（走到审批）
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '崩溃窗口' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()

  // 2) 人为抹掉 artifact.created 事件（模拟"事件没落库"），并预置缓存（模拟"工具已执行"）
  db.prepare("delete from events where run_id = ? and type = 'artifact.created'").run(runId)
  const callId = db.prepare("select payload_json from events where run_id = ? and type = 'approval.requested' limit 1").get(runId)
  const cid = JSON.parse(callId.payload_json).callId
  db.prepare('insert or replace into run_tool_results (run_id, call_id, ok, content, artifact_json, error, created_at) values (?,?,?,?,?,?,?)')
    .run(runId, cid, 1, '已写入 report.md', JSON.stringify({ path: 'report.md', mime: 'text/markdown', size: 10 }), null, now)

  // 3) 批准 → 恢复走缓存分支 → 应补发产物事件
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })

  let arts = 0
  for (let i = 0; i < 60; i++) {
    const txt = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
    arts = (txt.match(/event: artifact\.created/g) ?? []).length
    if (arts > 0) break
    await new Promise((r) => setTimeout(r, 150))
  }
  assert.equal(arts, 1, `恢复后应恰好补发一条产物事件，实际 ${arts}`)
})
