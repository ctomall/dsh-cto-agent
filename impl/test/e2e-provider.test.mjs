import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 创建 run 默认不等模型；测试需要确定性状态，开一个等待窗口
process.env.RUN_CREATE_WAIT_MS = process.env.RUN_CREATE_WAIT_MS ?? '8000'

// 端到端：真实 HTTP → OpenAI 兼容 provider（本地 mock，走流式协议）→ 工具调用 → 审批 → 产物
// 目的：把"配好 key 之后到底通不通"这件事，在拿不到真 key 时也能先验证一遍。
function mockProvider() {
  let call = 0
  return createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      call++
      const wantStream = (() => { try { return JSON.parse(body).stream === true } catch { return false } })()
      if (!wantStream) { res.writeHead(400); return res.end('expected stream') }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

      if (call === 1) {
        // 第一次：流式下发 tool_call 分片（fs.write，需审批）
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e', function: { name: 'fs.write', arguments: '{"path":"e2e.md",' } }] } }] })
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"# e2e 产物"}' } }] } }] })
      } else {
        // 第二次：流式下发两段文本
        send({ choices: [{ delta: { content: '已写入 ' } }] })
        send({ choices: [{ delta: { content: 'e2e.md' } }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
}

test('端到端：真实 HTTP provider（流式）→ 审批 → 产物 → 历史', async (t) => {
  const provider = mockProvider()
  await new Promise((r) => provider.listen(0, r))
  const workspace = mkdtempSync(join(tmpdir(), 'cube-e2e-'))

  process.env.MODEL_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`
  process.env.MODEL_NAME = 'mock-e2e'
  process.env.MODEL_API_KEY = 'sk-mock'
  process.env.WORKSPACE_ROOT = workspace

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    provider.close()
    rmSync(workspace, { recursive: true, force: true })
    delete process.env.MODEL_BASE_URL
    delete process.env.MODEL_NAME
    delete process.env.MODEL_API_KEY
    delete process.env.WORKSPACE_ROOT
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // driver 必须是真实 provider 形态，不是 fake
  const status = await (await fetch(`${base}/api/model/status`, { headers: H })).json()
  assert.match(status.driver, /^openai:/)
  assert.equal(status.real, true)

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'e2e' }) })).json()
  const { runId, driver } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '生成 e2e.md', sessionId: sid }) })).json()
  assert.match(driver, /^openai:/)

  // 事件流：应停在审批
  const ev1 = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: H })).text()
  assert.match(ev1, /event: tool\.started/)
  assert.match(ev1, /event: approval\.requested/)

  // 批准 → 落盘 → 第二轮 provider → 收尾
  const decided = await (await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })).json()
  assert.equal(decided.status, 'done')

  const ev2 = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: H })).text()
  for (const t2 of ['approval.decided', 'tool.finished', 'artifact.created', 'run.finished']) {
    assert.match(ev2, new RegExp(`event: ${t2.replace('.', '\\.')}`))
  }
  // 流式文本应分两段到达
  const deltas = [...ev2.matchAll(/event: text\.delta\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]).text)
  assert.ok(deltas.includes('已写入 ') && deltas.includes('e2e.md'), `实际增量: ${JSON.stringify(deltas)}`)

  // 产物真的落盘
  const file = join(workspace, runId, 'e2e.md')
  assert.equal(readFileSync(file, 'utf8'), '# e2e 产物')

  // 历史落库
  const { messages } = await (await fetch(`${base}/api/sessions/${sid}/messages`, { headers: H })).json()
  assert.equal(messages[0].role, 'user')
  assert.equal(messages.at(-1).role, 'assistant')
})
