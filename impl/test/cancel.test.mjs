import test from 'node:test'
import assert from 'node:assert/strict'

// 用可注入的假 driver 验证取消语义，不依赖真实网络（避免挂起的 provider 拖住进程）
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

test('运行中取消：状态 canceled，且不重复处理', async (t) => {
  const { base, db } = await boot(t)
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_c1', 'running', new Date().toISOString(), 't_a', 's_a1')

  const r = await fetch(`${base}/api/runs/r_c1/cancel`, { method: 'POST', headers: H })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'canceled')
  assert.equal(db.prepare('select status from runs where id = ?').get('r_c1').status, 'canceled')
})

test('已终态取消 → already_terminal', async (t) => {
  const { base, db } = await boot(t)
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_c2', 'done', new Date().toISOString(), 't_a', 's_a1')
  const body = await (await fetch(`${base}/api/runs/r_c2/cancel`, { method: 'POST', headers: H })).json()
  assert.equal(body.note, 'already_terminal')
})

test('跨租户取消 → 404；未知 run → 404', async (t) => {
  const { base, db } = await boot(t)
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_c3', 'running', new Date().toISOString(), 't_b', 's_b1')
  assert.equal((await fetch(`${base}/api/runs/r_c3/cancel`, { method: 'POST', headers: H })).status, 404)
  assert.equal((await fetch(`${base}/api/runs/nope/cancel`, { method: 'POST', headers: H })).status, 404)
})

test('取消会 abort 在途请求（AbortSignal 贯通）', async () => {
  const { AgentLoop } = await import('../src/loop.mjs')
  let seenSignal = null
  const events = []
  const rc = {
    create() {}, transition() {}, emitTo(_i, type, p) { events.push({ type, p }) },
    status: () => 'running',
  }
  const driver = {
    name: 'hang',
    complete: async ({ signal }) => {
      seenSignal = signal
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
      return { type: 'final', text: 'x' }
    },
  }
  const loop = new AgentLoop({ rc, tools: { schema: [], policy: {}, run: async () => ({}) }, driver, workspaceRoot: '/tmp', timeoutMs: 60_000 })
  const running = loop.start({ runId: 'r_x', tenantId: 't_a', sessionId: 's_a1', input: 'go' })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(seenSignal, 'driver 必须收到 AbortSignal')

  const out = loop.cancel('r_x')
  assert.equal(out.status, 'canceled')
  const res = await running
  assert.equal(res.status, 'canceled', '取消后 step 应返回 canceled 而不是 failed')
  assert.equal(events.some((e) => e.type === 'run.failed'), false, '取消不应产生 run.failed')
})
