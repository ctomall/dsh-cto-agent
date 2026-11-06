import test from 'node:test'
import assert from 'node:assert/strict'

// /api/settings 要如实反映运维旋钮，否则"设置页"又是猜的
test('/api/settings 暴露 agent 步数/超时/历史条数', async (t) => {
  process.env.AGENT_MAX_STEPS = '7'
  process.env.AGENT_TIMEOUT_MS = '90000'
  process.env.AGENT_HISTORY_LIMIT = '12'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    delete process.env.AGENT_MAX_STEPS
    delete process.env.AGENT_TIMEOUT_MS
    delete process.env.AGENT_HISTORY_LIMIT
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const b = await (await fetch(`${base}/api/settings`, { headers: { authorization: 'Bearer tok_a' } })).json()
  assert.equal(b.agent?.maxSteps, 7, 'settings 应暴露 maxSteps')
  assert.equal(b.agent?.timeoutMs, 90000)
  assert.equal(b.agent?.historyLimit, 12)
})
