import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../src/loop.mjs'

// ② 的核心承诺：**会话级授权命中后，同一工具第二次不再弹审批卡**。
// 这条此前只有浏览器级证据（cdp-grant-ui-check），没有单元级用例——
// 所以"把 grants.has 改成恒 false"这种破坏，测试竟然全绿（变异探针 v207 抓到）。
test('会话授权命中 → 发 approval.auto_approved，不发 approval.requested', async (t) => {
  const root = join(tmpdir(), `grant-skip-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const events = []
  let status = 'running'
  const rc = { create() {}, transition(_r, to) { status = to }, status: () => status, emitTo(_r, ty, p) { events.push({ ty, p }) } }
  const audit = []
  let step = 0
  const driver = {
    name: 'fake-test',
    // 第一步：让模型调用需要审批的工具；第二步：收尾
    complete: async () => {
      step += 1
      if (step === 1) return { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'a.md', content: 'x' } } }
      return { type: 'final', text: 'done' }
    },
  }
  const tools = {
    schema: [{ name: 'fs.write', description: 'w', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': 'confirm' },
    run: async () => ({ content: 'ok', artifact: { path: 'a.md', mime: 'text/markdown', size: 1 } }),
  }
  // 授权表：本会话对这个工具已授权
  const grants = {
    has: ({ tenantId, sessionId, tool }) => tenantId === 't_a' && sessionId === 's_a1' && tool === 'fs.write',
    add: () => {},
  }

  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: root, grants, audit: (e) => audit.push(e) })
  await loop.start({ runId: 'r1', input: '写一份报告', tenantId: 't_a', sessionId: 's_a1' })

  const requested = events.filter((e) => e.ty === 'approval.requested')
  const auto = events.filter((e) => e.ty === 'approval.auto_approved')
  assert.equal(requested.length, 0, '会话已授权时不应再弹审批卡')
  assert.equal(auto.length, 1, '应留下一条 auto_approved 事件（可审计）')
  assert.equal(auto[0].p.reason, 'session_grant')
  assert.equal(audit.filter((a) => a.decision === 'session_grant').length, 1, '审计要记 session_grant')
})
