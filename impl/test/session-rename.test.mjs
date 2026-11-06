import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}` }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('会话重命名：本人可改、能读回', async (t) => {
  const { base } = await boot(t)
  const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '旧名' }) })).json()
  const r = await fetch(`${base}/api/sessions/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ title: '新名字' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { id, title: '新名字' })
  const one = await (await fetch(`${base}/api/sessions/${id}`, { headers: H })).json()
  assert.equal(one.session.title, '新名字')
})

test('会话重命名：空标题/超长 → 400；跨租户 → 404', async (t) => {
  const { base } = await boot(t)
  const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '待改' }) })).json()

  assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ title: '   ' }) })).status, 400)
  assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ title: 'x'.repeat(61) }) })).status, 400)
  const cross = await fetch(`${base}/api/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer tok_b' }, body: JSON.stringify({ title: '劫持' }) })
  assert.equal(cross.status, 404)

  const one = await (await fetch(`${base}/api/sessions/${id}`, { headers: H })).json()
  assert.equal(one.session.title, '待改', '跨租户改名不得生效')
})
