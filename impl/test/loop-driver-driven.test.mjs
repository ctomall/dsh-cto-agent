import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/loop.mjs'

// 目标：证明「事件序列由模型（driver）的决策决定」，而不是 loop 里写死的剧本。
// 三个 driver 给出三种决策，事件序列必须随之改变。
function harness(driver, { policy = 'confirm', tools = { fs: async () => ({ content: 'ok' }) } } = {}) {
  const events = []
  let status = 'running'
  const rc = {
    create() {},
    transition(_id, to) { status = to },
    status: () => status,
    emitTo(_id, type, p) { events.push({ type, p }) },
  }
  const toolBox = {
    schema: [{ name: 'fs.write', description: '写文件', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': policy },
    run: async () => tools.fs(),
  }
  const loop = new AgentLoop({ rc, tools: toolBox, driver, workspaceRoot: '/tmp' })
  return { loop, events }
}

const types = (events) => events.map((e) => e.type)

test('driver 只给 final → 只有文本与收尾，没有任何工具/审批事件', async () => {
  const driver = { name: 'final-only', complete: async () => ({ type: 'final', text: '不需要工具' }) }
  const { loop, events } = harness(driver)
  const out = await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: '你好' })
  assert.equal(out.status, 'done')
  assert.deepEqual(types(events), ['text.delta', 'text.delta', 'run.finished'])
  assert.ok(!types(events).some((t) => t.startsWith('tool.') || t.startsWith('approval.')))
})

test('driver 给 tool_call（policy=confirm）→ tool.started + approval.requested 挂起，而不是自己往下跑', async () => {
  const driver = {
    name: 'tool-driver',
    complete: async () => ({ type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'a.md' } } }),
  }
  const { loop, events } = harness(driver)
  const out = await loop.start({ runId: 'r2', tenantId: 't_a', sessionId: 's_a1', input: '写文件' })
  assert.equal(out.status, 'waiting_approval')
  assert.deepEqual(types(events), ['text.delta', 'tool.started', 'approval.requested'])
})

test('driver 抛错 → run.failed，且不产生 run.finished', async () => {
  const driver = { name: 'boom', complete: async () => { throw new Error('provider 500') } }
  const { loop, events } = harness(driver)
  const out = await loop.start({ runId: 'r3', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  assert.equal(out.status, 'failed')
  assert.ok(types(events).includes('run.failed'))
  assert.ok(!types(events).includes('run.finished'))
})

test('同一 loop、换 driver 决策 → 事件序列随之不同（不是硬编码剧本）', async () => {
  const a = harness({ name: 'A', complete: async () => ({ type: 'final', text: 'ok' }) })
  const b = harness({
    name: 'B',
    complete: async () => ({ type: 'tool_call', call: { id: 'c9', name: 'fs.write', args: {} } }),
  })
  await a.loop.start({ runId: 'ra', tenantId: 't_a', sessionId: 's_a1', input: 'go' })
  await b.loop.start({ runId: 'rb', tenantId: 't_a', sessionId: 's_a1', input: 'go' })
  assert.notDeepEqual(types(a.events), types(b.events))
})
