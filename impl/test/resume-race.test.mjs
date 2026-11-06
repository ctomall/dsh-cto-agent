import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/loop.mjs'

// 判完终态 → 真正迁移之间被 cancel 抢先：不应该是 500，而是 state_changed
test('resume 遇到非法迁移 → 返回 state_changed 而不是抛错', async () => {
  const events = []
  let status = 'waiting_approval'
  const rc = {
    create() {}, emitTo(_id, t, p) { events.push({ t, p }) },
    status: () => status,
    transition(_id, to) {
      if (to === 'running') { status = 'canceled'; throw new Error('illegal transition: canceled -> running') }
      status = to
    },
  }
  const driver = { name: 'stub', complete: async () => ({ type: 'final', text: 'x' }) }
  const loop = new AgentLoop({
    rc,
    tools: { schema: [], policy: {}, run: async () => ({ content: 'ok' }) },
    driver,
    workspaceRoot: '/tmp',
    pendingStore: {
      save() {}, clear() {},
      load: () => ({ messages: [], call: { name: 'fs.write', args: {} }, callId: 'c1', steps: 0, tenantId: 't_a', sessionId: 's_a1' }),
    },
  })

  const out = await loop.resume({ runId: 'r_race', decision: 'allow_once' })
  assert.equal(out.note, 'state_changed')
  assert.equal(out.status, 'canceled')
  assert.ok(String(out.error).includes('illegal transition'))
})
