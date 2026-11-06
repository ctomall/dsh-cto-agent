import test from 'node:test'
import assert from 'node:assert/strict'

test('同一 (runId, callId) 只真正执行一次：第二次走缓存并以 replayed 标记', async () => {
  const { AgentLoop } = await import('../src/loop.mjs')
  const events = []
  const rc = {
    create() {}, transition() {}, emitTo(_id, type, p) { events.push({ type, p }) },
    status: () => 'running',
  }
  let calls = 0
  const tools = {
    schema: [],
    policy: {},
    run: async () => { calls += 1; return { content: 'wrote report.md', artifact: { path: 'report.md', mime: 'text/markdown', size: 6 } } },
  }
  const store = new Map()
  const toolResults = {
    get: (runId, callId) => store.get(`${runId}:${callId}`) ?? null,
    put: ({ runId, callId, ok, content, artifact, error }) => store.set(`${runId}:${callId}`, { ok, content, artifact, error }),
  }
  // 第二次 step 直接结束，避免无限循环
  const driver = { name: 'stub', complete: async () => ({ type: 'final', text: 'done' }) }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: '/tmp', toolResults })

  const args = { runId: 'r_idem', messages: [], call: { name: 'fs.write', args: {} }, callId: 'c1', steps: 0, tenantId: 't_a', sessionId: 's_a1' }
  await loop.executeAndContinue(args)
  assert.equal(calls, 1)

  // 模拟"审批/恢复重放"：同样的 runId+callId 再走一次
  await loop.executeAndContinue({ ...args, messages: [] })
  assert.equal(calls, 1, '缓存命中后不得再次执行工具')

  const finished = events.filter((e) => e.type === 'tool.finished')
  assert.equal(finished.length, 2)
  assert.equal(finished[1].p.replayed, true, '重放要打 replayed 标记')
})
