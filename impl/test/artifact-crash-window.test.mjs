import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../src/loop.mjs'
import { createTools } from '../src/tools.mjs'

// 崩溃窗口：工具已执行、artifact 事件尚未落库。
// 恢复时缓存里有产物 → 必须补发 artifact.created；若事件流已有则不重复。
function build({ artifactExists }) {
  const root = join(tmpdir(), `cw-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const events = []
  const rc = { create() {}, transition() {}, status: () => 'running', emitTo(_r, t, p) { events.push({ t, p }) } }
  const toolResults = {
    get: () => ({ ok: 1, content: '已写入 a.md', error: null, artifact: { path: 'a.md', mime: 'text/markdown', size: 3 } }),
    put: () => {},
  }
  const loop = new AgentLoop({ rc, tools: createTools({ workspaceRoot: root }), driver: { name: 'd', complete: async () => ({ type: 'final', text: 'ok' }) }, workspaceRoot: root, toolResults, artifactExists })
  return { loop, events, root }
}

test('崩溃窗口：事件流里没有该产物时补发 artifact.created', async (t) => {
  const { loop, events, root } = build({ artifactExists: () => false })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await loop.executeAndContinue({ runId: 'r1', messages: [], call: { id: 'c1', name: 'fs.write', args: {} }, callId: 'c1', steps: 1, tenantId: 't_a', sessionId: 's_a1' })
  const arts = events.filter((e) => e.t === 'artifact.created')
  assert.equal(arts.length, 1, '应补发一次产物事件')
  assert.equal(arts[0].p.replayed, true)
})

test('崩溃窗口：事件流已有该产物时不重复补发', async (t) => {
  const { loop, events, root } = build({ artifactExists: () => true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await loop.executeAndContinue({ runId: 'r1', messages: [], call: { id: 'c1', name: 'fs.write', args: {} }, callId: 'c1', steps: 1, tenantId: 't_a', sessionId: 's_a1' })
  assert.equal(events.filter((e) => e.t === 'artifact.created').length, 0, '已有产物时不应重复')
})
