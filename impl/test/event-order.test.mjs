import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/loop.mjs'

// 不变量：事件一旦发出，对应状态必须已经落库/落缓存——否则订阅方读到旧值
// （v106 就是"先发 approval.decided 再写授权"，导致面板永远显示未授权）

function harness({ policy = 'confirm', grants = null, toolResults = null, onEmit = null } = {}) {
  const events = []
  let status = 'running'
  const rc = {
    create() {},
    transition(_id, to) { status = to },
    status: () => status,
    emitTo(_id, type, p) { events.push({ type, p }); if (onEmit) onEmit(type, p) },
  }
  const tools = {
    schema: [{ name: 'fs.write', description: 'w', parameters: { type: 'object', properties: {} } }],
    policy: { 'fs.write': policy },
    run: async () => ({ content: 'ok', artifact: { path: 'a.md', mime: 'text/markdown', size: 1 } }),
  }
  return { rc, tools, events }
}

test('approval.decided 发出时，会话授权必须已经在库里', async () => {
  const store = new Map()
  const grants = {
    has: ({ tool }) => store.has(tool),
    add: ({ tool }) => store.set(tool, true),
    list: () => [...store.keys()].map((tool) => ({ tool, scope: 'session' })),
  }
  let seenAtEmit = null
  const { rc, tools } = harness({
    grants,
    onEmit: (type) => { if (type === 'approval.decided') seenAtEmit = grants.list().map((g) => g.tool) },
  })
  const loop = new AgentLoop({ rc, tools, grants, driver: { name: 'd', complete: async () => ({ type: 'final', text: 'x' }) }, workspaceRoot: '/tmp' })
  // 先模拟一次"挂起"，再用 resume 批准
  loop.pendingStore = { save() {}, clear() {}, load: () => ({ messages: [], call: { name: 'fs.write', args: {} }, callId: 'c1', steps: 0, tenantId: 't_a', sessionId: 's_a1' }) }
  const out = await loop.resume({ runId: 'r1', decision: 'allow_session' })
  assert.equal(out.status, 'done')
  assert.deepEqual(seenAtEmit, ['fs.write'], 'approval.decided 发出时授权必须已落库')
})

test('tool.finished / artifact.created 发出时，幂等缓存必须已经写入', async () => {
  const cache = new Map()
  const toolResults = {
    get: (runId, callId) => cache.get(`${runId}:${callId}`) ?? null,
    put: (row) => cache.set(`${row.runId}:${row.callId}`, row),
  }
  const seen = []
  const { rc, tools } = harness({
    toolResults,
    onEmit: (type) => { if (type === 'tool.finished' || type === 'artifact.created') seen.push([type, cache.size]) },
  })
  const loop = new AgentLoop({ rc, tools, driver: { name: 'd', complete: async () => ({ type: 'tool_call', call: { id: 'c9', name: 'fs.write', args: {} } }) }, workspaceRoot: '/tmp', toolResults, grants: null })
  // policy=auto 直接执行，避免挂起
  loop.tools.policy['fs.write'] = 'auto'
  await loop.start({ runId: 'r2', tenantId: 't_a', sessionId: 's_a1', input: '写' })
  const finished = seen.find(([t]) => t === 'tool.finished')
  const artifact = seen.find(([t]) => t === 'artifact.created')
  assert.ok(finished && finished[1] >= 1, `tool.finished 时缓存应已写入：${JSON.stringify(seen)}`)
  assert.ok(artifact && artifact[1] >= 1, `artifact.created 时缓存应已写入：${JSON.stringify(seen)}`)
})

test('run.finished 发出前，助手消息必须已经交给 store', async () => {
  const calls = []
  const { rc, tools } = harness({ policy: 'auto' })
  const loop = new AgentLoop({
    rc, tools,
    driver: { name: 'd', complete: async () => ({ type: 'final', text: '答' }) },
    workspaceRoot: '/tmp',
    store: (row) => calls.push(['store', row.role]),
  })
  const origEmit = rc.emitTo
  rc.emitTo = (id, type, p) => { if (type === 'run.finished') calls.push(['emit', 'run.finished']); return origEmit(id, type, p) }
  await loop.start({ runId: 'r3', tenantId: 't_a', sessionId: 's_a1', input: '问' })
  const storeIdx = calls.findIndex(([k]) => k === 'store')
  const finishIdx = calls.findIndex(([k, v]) => k === 'emit' && v === 'run.finished')
  assert.ok(storeIdx >= 0 && storeIdx < finishIdx, `store 应先于 run.finished：${JSON.stringify(calls)}`)
})
