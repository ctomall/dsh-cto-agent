import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../src/loop.mjs'
import { createTools } from '../src/tools.mjs'

// 目标 ① 的硬性要求：事件序列由"模型行为"决定，而不是硬编码。
// 证明方式 = 反事实：同一套代码，换不同的模型行为/策略，必须得到不同的序列。

function harness({ driver, tools, root }) {
  const events = []
  let status = 'running'
  const rc = {
    create() {},
    transition(_runId, to) { status = to },
    status: () => status,
    emitTo(_runId, type, payload) { events.push({ type, payload }) },
  }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: root })
  return { loop, events, status: () => status }
}

const types = (evts) => evts.map((e) => e.type)
const askWrite = () => (d) => (d.n = (d.n ?? 0) + 1) === 1
  ? { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'a.md', content: 'x' } } }
  : { type: 'final', text: '已写入' }

test('模型行为不同 → 事件序列不同（反事实四连）', async (t) => {
  const root = join(tmpdir(), `seq-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // A：要工具 + 策略 auto → 直接执行并产出
  // createTools 的 policy 是它返回对象里的字段，不接受覆盖参数——这里显式改写
  const toolsAuto = createTools({ workspaceRoot: root })
  toolsAuto.policy = { ...toolsAuto.policy, 'fs.write': 'auto' }
  const A = harness({ driver: { name: 'A', complete: async () => askWrite()(A.driverState ??= {}) }, tools: toolsAuto, root })
  const aOut = await A.loop.start({ runId: 'rA', tenantId: 't_a', sessionId: 's_a', input: '写文件' })
  assert.equal(aOut.status, 'done')
  const aSeq = types(A.events)
  assert.ok(aSeq.includes('tool.started') && aSeq.includes('tool.finished'), 'A 应执行工具')
  assert.ok(aSeq.includes('artifact.created'), 'A 应产生产物')
  assert.ok(!aSeq.includes('approval.requested'), 'A 策略为 auto，不应弹审批')

  // A2：同一模型行为，策略 confirm → 停在审批，未执行工具
  const toolsConfirm = createTools({ workspaceRoot: root })
  toolsConfirm.policy = { ...toolsConfirm.policy, 'fs.write': 'confirm' }
  const A2 = harness({ driver: { name: 'A2', complete: async () => askWrite()(A2.driverState ??= {}) }, tools: toolsConfirm, root })
  const a2Out = await A2.loop.start({ runId: 'rA2', tenantId: 't_a', sessionId: 's_a2', input: '写文件' })
  assert.equal(a2Out.status, 'waiting_approval')
  const a2Seq = types(A2.events)
  assert.ok(a2Seq.includes('approval.requested'), 'A2 必须弹审批')
  assert.ok(!a2Seq.includes('tool.finished'), 'A2 未批准，不应有 tool.finished')

  // B：不要工具 → 只有文本
  const B = harness({ driver: { name: 'B', complete: async () => ({ type: 'final', text: '无需工具' }) }, tools: toolsAuto, root })
  const bOut = await B.loop.start({ runId: 'rB', tenantId: 't_a', sessionId: 's_b', input: '聊聊天' })
  assert.equal(bOut.status, 'done')
  const bSeq = types(B.events)
  assert.ok(!bSeq.includes('tool.started'), 'B 不应执行工具')

  // C：要一个策略外的工具 → 拒绝
  const C = harness({
    driver: { name: 'C', complete: async () => (C.d = (C.d ?? 0) + 1) === 1
      ? { type: 'tool_call', call: { id: 'c9', name: 'fs.remove_all', args: {} } }
      : { type: 'final', text: '那算了' } },
    tools: toolsAuto,
    root,
  })
  const cOut = await C.loop.start({ runId: 'rC', tenantId: 't_a', sessionId: 's_c', input: '删库' })
  assert.equal(cOut.status, 'done')
  const cSeq = types(C.events)
  const denied = C.events.find((e) => e.type === 'tool.finished' && e.payload.ok === false)
  assert.equal(denied?.payload.error, 'denied_by_policy', 'C 必须被策略拒绝')

  // 反事实断言：四条序列两两不同
  const seqs = [aSeq, a2Seq, bSeq, cSeq].map((s) => s.join('|'))
  assert.equal(new Set(seqs).size, 4, `四条序列应互不相同，实际：\n${seqs.join('\n')}`)

  console.log('A (auto)   :', aSeq.join(' '))
  console.log('A2(confirm):', a2Seq.join(' '))
  console.log('B (no tool):', bSeq.join(' '))
  console.log('C (denied) :', cSeq.join(' '))
})
