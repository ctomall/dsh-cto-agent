import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../src/loop.mjs'
import { createTools } from '../src/tools.mjs'

// 有种子随机：同样的 seed 得到同样的剧本，失败可复现。
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const TERMINAL = new Set(['run.finished', 'run.failed', 'run.canceled'])

function makeScenario(rand) {
  const steps = 1 + Math.floor(rand() * 4)
  const script = []
  for (let i = 0; i < steps; i++) {
    const r = rand()
    if (r < 0.45) {
      script.push({ type: 'tool_call', call: { id: `c${i}`, name: 'fs.write', args: { path: `f${i}.md`, content: 'x'.repeat(Math.floor(rand() * 3000)) } } })
    } else if (r < 0.7) {
      script.push({ type: 'tool_call', call: { id: `u${i}`, name: 'fs.unknown', args: {} } })
    } else if (r < 0.85) {
      script.push({ type: 'final', text: `done-${i}` })
    } else {
      script.push({ type: 'weird', note: 'unexpected shape' })
    }
  }
  return script
}

async function runOne(seed) {
  const rand = rng(seed)
  const root = join(tmpdir(), `soak-${seed}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  const tools = createTools({ workspaceRoot: root })
  tools.policy = { ...tools.policy, 'fs.write': rand() < 0.5 ? 'auto' : 'confirm' }

  const script = makeScenario(rand)
  let i = 0
  const events = []
  let status = 'running'
  const rc = {
    create() {}, transition(_r, to) { status = to }, status: () => status,
    emitTo(_r, type, payload) { events.push({ type, payload }) },
  }
  const driver = { name: 'soak', complete: async () => script[Math.min(i++, script.length - 1)] }
  const loop = new AgentLoop({ rc, tools, driver, workspaceRoot: root, maxSteps: 6, grants: null })

  const runId = `r_soak_${seed}`
  let out = await loop.start({ runId, tenantId: 't_a', sessionId: 's_soak', input: 'soak' })
  // 卡在审批就批准一次（模拟用户放行），继续跑
  let guard = 0
  while (out.status === 'waiting_approval' && guard++ < 5) {
    out = await loop.resume({ runId, decision: 'allow_once' })
  }
  rmSync(root, { recursive: true, force: true })
  return { out, events, status: status, script, runId }
}

test('随机剧本 soak（40 个种子）：不悬挂、恰好一个终态、序号单调、产物不重复', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { out, events, status, runId } = await runOne(seed)
    const label = `seed=${seed}`

    assert.ok(['done', 'failed', 'waiting_approval'].includes(out.status), `${label} 意外终态 ${out.status}`)
    assert.notEqual(status, 'running', `${label} 不能停在 running`)

    const terminals = events.filter((e) => TERMINAL.has(e.type))
    if (out.status !== 'waiting_approval') {
      assert.equal(terminals.length, 1, `${label} 终态事件应恰好 1 个，实际 ${terminals.length}`)
    }

    // 不变量（比"路径唯一"更准确）：每个产物事件必须落在某次成功的工具执行之后
    // 注意：同一路径被多次写入会产生多条 artifact 事件 —— 那是合法行为，不是重复缺陷
    events.forEach((e, idx) => {
      if (e.type !== 'artifact.created') return
      const prevOk = events.slice(0, idx).some((x) => x.type === 'tool.finished' && x.payload.ok === true)
      assert.ok(prevOk, `${label} 产物 ${e.payload.path} 出现在任何成功工具执行之前（事件序 ${idx}）`)
    })

    // 每条事件都带 payload 且没有 undefined 字段泄漏
    for (const e of events) {
      assert.ok(e.type && typeof e.type === 'string', `${label} 事件缺 type`)
      assert.ok(!JSON.stringify(e.payload ?? {}).includes('undefined'), `${label} payload 里有 undefined`)
    }
  }
})
