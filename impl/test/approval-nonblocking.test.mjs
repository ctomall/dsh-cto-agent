import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// 审批后模型还要再跑一步（真模型几十秒）：审批请求不能等它。
test('慢 provider 下审批请求立即返回，恢复在后台继续', async (t) => {
  const slow = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = (() => { try { return JSON.parse(raw) } catch { return {} } })()
      const hasTool = (body.messages ?? []).some((m) => m.role === 'tool')
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (!hasTool) {
          res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.write', arguments: '{"path":"a.md","content":"x"}' } }] } }] }))
        } else {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '写完' }, finish_reason: 'stop' }] }))
        }
      }, 3000) // 每一步都慢 3s
    })
  })
  await new Promise((r) => slow.listen(0, r))
  t.after(() => slow.close())

  process.env.MODEL_BASE_URL = `http://127.0.0.1:${slow.address().port}/v1`
  process.env.MODEL_NAME = 'slow'
  process.env.MODEL_API_KEY = 'sk-test'
  process.env.RUN_CREATE_WAIT_MS = '8000'      // 创建时等到审批点，便于断言
  process.env.RUN_TRANSITION_WAIT_MS = '0'     // 审批不等恢复

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    for (const k of ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY', 'RUN_CREATE_WAIT_MS', 'RUN_TRANSITION_WAIT_MS']) delete process.env[k]
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '审批非阻塞' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写文件', sessionId: sid }) })).json()

  const t0 = Date.now()
  const ap = await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  const ms = Date.now() - t0
  assert.equal(ap.status, 200)
  // 语义判据：请求必须在"模型第二步能返回"之前结束。
  // 不用固定的 <1000ms —— 机器负载高时那是假红灯（本机 4 路并发实测过）。
  assert.ok(ms < 3000, `审批不该等模型继续跑，实际 ${ms}ms（provider 需 3000ms 才回）`)
  assert.equal((await ap.json()).status, 'accepted')

  // 后台继续：最终应完成并落产物
  let finished = false
  for (let i = 0; i < 60; i++) {
    const ev = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
    if (ev.includes('run.finished')) { finished = true; break }
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.ok(finished, '审批后应继续跑完')
})
