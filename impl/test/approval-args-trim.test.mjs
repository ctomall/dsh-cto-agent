import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../src/loop.mjs'
import { createTools } from '../src/tools.mjs'

test('审批事件里的大参数被截断，但文件仍完整写入（不因摘要丢内容）', async (t) => {
  const root = join(tmpdir(), `trim-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const big = 'A'.repeat(5000)
  const events = []
  let status = 'running'
  const rc = { create() {}, transition(_i, to) { status = to }, status: () => status, emitTo(_i, ty, p) { events.push({ ty, p }) } }
  const tools = createTools({ workspaceRoot: root })

  let n = 0
  const driver = {
    name: 'd',
    complete: async () => (++n === 1
      ? { type: 'tool_call', call: { id: 'c1', name: 'fs.write', args: { path: 'big.md', content: big } } }
      : { type: 'final', text: 'done' }),
  }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: root })
  const out = await loop.start({ runId: 'r_trim', tenantId: 't_a', sessionId: 's_a1', input: '写个大的' })
  assert.equal(out.status, 'waiting_approval')

  const ev = events.find((e) => e.ty === 'approval.requested')
  assert.ok(ev, '应有审批事件')
  const sent = JSON.stringify(ev.p)
  assert.ok(sent.length < 1500, `审批事件不应携带完整大参数，实际 ${sent.length} 字节`)
  assert.equal(ev.p.argsTruncated, true, '应标记已截断')
  assert.match(ev.p.args.content, /已截断/)

  // 关键：执行时用的是完整参数 —— 批准后写入的内容必须完整
  const resumed = await loop.resume({ runId: 'r_trim', decision: 'allow_once' })
  assert.equal(resumed.status, 'done')
  const file = readFileSync(join(root, 'r_trim', 'big.md'), 'utf8')
  assert.equal(file.length, 5000, `文件应写满 5000 字，实际 ${file.length}`)
})
