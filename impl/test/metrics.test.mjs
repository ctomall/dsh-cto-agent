import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetrics } from '../src/metrics.mjs'

test('计数器与仪表按 Prometheus 文本格式输出', () => {
  const m = createMetrics()
  m.inc('http_requests_total', { status: 200 })
  m.inc('http_requests_total', { status: 200 })
  m.inc('http_requests_total', { status: 401 })
  m.set('model_real', {}, 0)
  const out = m.render()
  assert.match(out, /# TYPE http_requests_total counter/)
  assert.match(out, /http_requests_total\{status="200"\} 2/)
  assert.match(out, /http_requests_total\{status="401"\} 1/)
  assert.match(out, /# TYPE model_real gauge/)
  assert.match(out, /model_real 0/)
})

test('HTTP /metrics 暴露关键指标', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份', sessionId: 's_a1' }) })

  const r = await fetch(`${base}/metrics`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/plain/)
  const body = await r.text()
  for (const k of ['runs_created_total', 'model_real', 'session_grants']) {
    assert.match(body, new RegExp(k))
  }
  assert.match(body, /model_real 0/, '未接真实模型时必须是 0')
})

test('零值指标也要出现（区分"没数据"与"没这个指标"）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/metrics`)).text()
  assert.match(body, /runs_created_total\{driver="fake"\} 0/)
  assert.match(body, /approvals_total\{decision="allow_session"\} 0/)
  assert.match(body, /rate_limited_total\{bucket="login"\} 0/)
})
