import test from 'node:test'
import assert from 'node:assert/strict'

// 创建 run 默认不等模型；测试需要确定性状态，开一个等待窗口
process.env.RUN_CREATE_WAIT_MS = process.env.RUN_CREATE_WAIT_MS ?? '8000'

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

test('run 结束后消息落库，按时间顺序返回 user → assistant', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '历史' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '读一下 report.md', sessionId: sid }) })).json()
  // fs.read 是 auto，不需要审批
  const res = await fetch(`${base}/api/sessions/${sid}/messages`, { headers: H })
  assert.equal(res.status, 200)
  const { messages } = await res.json()
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'])
  assert.match(messages[0].content, /读一下 report\.md/)
  assert.ok(messages[1].content.length > 0)
  assert.ok(runId)
})

test('待审批时也会记录 user 消息（不丢上下文）', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '审批中' }) })).json()
  await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份文件', sessionId: sid }) })
  const { messages } = await (await fetch(`${base}/api/sessions/${sid}/messages`, { headers: H })).json()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
})

test('跨租户读历史 → 404', async (t) => {
  const { base } = await boot(t)
  const r = await fetch(`${base}/api/sessions/s_a1/messages`, { headers: { authorization: 'Bearer tok_b' } })
  assert.equal(r.status, 404)
})

test('空会话返回空数组', async (t) => {
  const { base } = await boot(t)
  const { messages } = await (await fetch(`${base}/api/sessions/s_a1/messages`, { headers: H })).json()
  assert.deepEqual(messages, [])
})
