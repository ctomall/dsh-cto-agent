import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/loop.mjs'

// 真实模型可能返回意料之外的形状：不能崩、不能把 run 挂在 running
function harness(driver) {
  const events = []
  let status = 'running'
  const rc = {
    create() {},
    transition(_id, to) { status = to },
    status: () => status,
    emitTo(_id, type, p) { events.push({ type, p }) },
  }
  const tools = {
    schema: [{ name: 'fs.write', description: 'w', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': 'auto' },
    run: async (_n, args) => {
      if (!args || !args.path) throw new Error('bad args')
      return { content: 'ok', artifact: null }
    },
  }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: '/tmp' })
  return { loop, rc, events, status: () => status }
}

test('未知工具 → denied_by_policy，run 不崩', async () => {
  const driver = { name: 'd', complete: async () => ({ type: 'tool_call', call: { id: 'c1', name: 'fs.rm_rf', args: {} } }) }
  const { loop, events } = harness(driver)
  const out = await loop.start({ runId: 'r1', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  // 模型一直重复请求被拒的工具 → 由 maxSteps 收口为 failed（有界，不会挂死）
  assert.equal(out.status, 'failed')
  const denied = events.find((e) => e.type === 'tool.finished' && e.p.ok === false)
  assert.equal(denied?.p.error, 'denied_by_policy')
  assert.ok(events.some((e) => e.type === 'run.failed' && /超过最大步数/.test(String(e.p.error))), '应以步数上限收尾')
})

test('参数非法（工具抛错）→ tool.finished ok:false，run 继续到 final', async () => {
  let n = 0
  const driver = {
    name: 'd',
    complete: async () => {
      n += 1
      return n === 1
        ? { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: {} } }
        : { type: 'final', text: '放弃了' }
    },
  }
  const { loop, events } = harness(driver)
  const out = await loop.start({ runId: 'r2', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  assert.equal(out.status, 'done')
  const failedTool = events.find((e) => e.type === 'tool.finished' && e.p.ok === false)
  assert.ok(failedTool, '应有失败的工具事件')
  assert.match(String(failedTool.p.error), /bad args/)
})

test('模型返回未知 type → run 必须失败收尾，而不是抛异常/停在 running', async () => {
  const driver = { name: 'd', complete: async () => ({ type: 'reasoning', thought: '???' }) }
  const { loop, events, status } = harness(driver)
  const out = await loop.start({ runId: 'r3', tenantId: 't_a', sessionId: 's_a1', input: 'x' })
  assert.notEqual(status(), 'running', `run 不应停在 running（当前 ${status()}）`)
  assert.ok(['failed', 'done'].includes(out.status), `终态应为 failed/done，实际 ${out.status}`)
  if (out.status === 'failed') {
    assert.ok(events.some((e) => e.type === 'run.failed'), '失败要有 run.failed 事件')
  }
})
