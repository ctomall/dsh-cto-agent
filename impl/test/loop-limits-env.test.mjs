import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/loop.mjs'

// 步数是"安全阀"：真实模型可能比桩驱动更啰嗦，运维需要能调
test('maxSteps 可配：步数用尽时以 run.failed 收口并带上限说明', async () => {
  const events = []
  let status = 'running'
  const rc = {
    create() {}, transition(_i, to) { status = to }, status: () => status,
    emitTo(_i, t, p) { events.push({ t, p }) },
  }
  const tools = {
    schema: [{ name: 'fs.write', description: 'w', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': 'auto' },
    run: async () => ({ content: 'ok', artifact: null }),
  }
  let calls = 0
  const driver = { name: 'd', complete: async () => { calls += 1; return { type: 'tool_call', call: { id: `c${calls}`, name: 'fs.write', args: { path: 'a.md' } } } } }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: '/tmp', maxSteps: 3 })
  const out = await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  assert.equal(out.status, 'failed')
  assert.equal(calls, 3, `应恰好调用 3 次模型，实际 ${calls}`)
  const failed = events.find((e) => e.t === 'run.failed')
  assert.match(String(failed?.p.error), /超过最大步数 3/)
})
