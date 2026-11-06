import test from 'node:test'
import assert from 'node:assert/strict'

// 真实模型首 token 可能很慢：长连接必须发心跳，否则边缘/代理会按空闲超时断开。
test('SSE 长连接会发 keep-alive 心跳（慢模型下连接不掉）', async (t) => {
  // 心跳间隔可配：测试用 300ms，避免每次升级门禁都多花 15 秒
  process.env.SSE_HEARTBEAT_MS = '300'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.SSE_HEARTBEAT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // 造一个"卡在审批"的 run：之后没有事件，正适合观察心跳
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '心跳' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 300))

  const ctrl = new AbortController()
  const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: { authorization: 'Bearer tok_a' }, signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 5000
  let heartbeats = 0
  while (Date.now() < deadline && heartbeats === 0) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    heartbeats = (buf.match(/: keep-alive/g) ?? []).length
  }
  ctrl.abort()
  assert.ok(heartbeats > 0, `5s 内未收到心跳（间隔 300ms）；已收到内容：${buf.slice(0, 200)}`)
})
