import test from 'node:test'
import assert from 'node:assert/strict'

// HTTP 层畸形输入：无论多脏，都不该 5xx，更不该让服务失去响应。
test('畸形请求不产生 5xx，服务保持可用', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { authorization: 'Bearer tok_a' }

  const cases = [
    ['损坏的 JSON', () => fetch(`${base}/api/runs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{invalid' })],
    ['JSON 是数组', () => fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '[]' })],
    ['JSON 是数字', () => fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '123' })],
    ['空 body', () => fetch(`${base}/api/runs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' } })],
    ['路径含 %00', () => fetch(`${base}/api/sessions/%00`, { headers: H })],
    ['超长查询串', () => fetch(`${base}/api/audit?limit=${'9'.repeat(4000)}`, { headers: H })],
    ['非法方法', () => fetch(`${base}/api/sessions`, { method: 'PURGE', headers: H })],
    ['巨大标题', () => fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(50000) }) })],
  ]

  for (const [name, send] of cases) {
    const r = await send().catch((e) => ({ status: 0, __err: e }))
    if (r.__err) continue // 连接被拒也算"没给出 5xx"，但下面会用正常请求验活
    assert.ok(r.status < 500, `${name} 触发了 5xx：${r.status}`)
  }

  // 关键：经过这些脏请求后，服务仍然可用
  const alive = await fetch(`${base}/api/version`)
  assert.equal(alive.status, 200, '服务在畸形请求后失去响应')
  const ok = await fetch(`${base}/api/sessions`, { headers: H })
  assert.equal(ok.status, 200, '正常鉴权请求仍应可用')
})
