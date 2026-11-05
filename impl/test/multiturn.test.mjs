import test from 'node:test'
import assert from 'node:assert/strict'

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
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) })

test('第二轮能看到上一轮上下文（多轮对话成立）', async (t) => {
  const { base } = await boot(t)
  const { id: sid } = await (await post(base, '/api/sessions', { title: '多轮' })).json()

  await (await post(base, '/api/runs', { input: '读一下 report.md', sessionId: sid })).json()
  const second = await (await post(base, '/api/runs', { input: '再读一次', sessionId: sid })).json()

  const { messages } = await (await fetch(`${base}/api/sessions/${sid}/messages`, { headers: H })).json()
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.ok(second.runId)
})

test('不同会话不共享上下文', async (t) => {
  const { base } = await boot(t)
  const a = await (await post(base, '/api/sessions', { title: 'A' })).json()
  const b = await (await post(base, '/api/sessions', { title: 'B' })).json()
  await post(base, '/api/runs', { input: '读一下 report.md', sessionId: a.id })
  await post(base, '/api/runs', { input: '读一下 report.md', sessionId: b.id })
  const ma = await (await fetch(`${base}/api/sessions/${a.id}/messages`, { headers: H })).json()
  const mb = await (await fetch(`${base}/api/sessions/${b.id}/messages`, { headers: H })).json()
  assert.equal(ma.messages.length, 2)
  assert.equal(mb.messages.length, 2)
})

test('历史有上限，不会无限增长', async () => {
  const { AgentLoop } = await import('../src/loop.mjs')
  const seen = []
  const driver = { name: 'spy', complete: async ({ messages }) => { seen.push(messages.length); return { type: 'final', text: 'ok' } } }
  const rc = {
    create() {}, transition() {}, emitTo() {},
  }
  const loop = new AgentLoop({
    rc,
    tools: { schema: [], policy: {}, run: async () => ({}) },
    driver,
    workspaceRoot: '/tmp',
    historyLimit: 5,
    loadHistory: ({ limit }) => Array.from({ length: limit }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `h${i}` })),
    store: () => {},
  })
  await loop.start({ runId: 'r9', tenantId: 't_a', sessionId: 's_a1', input: '新一句' })
  assert.equal(seen[0], 6, '5 条历史 + 当前 user')
})
