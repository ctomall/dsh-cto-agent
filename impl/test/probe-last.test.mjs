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
const H = { authorization: 'Bearer tok_a' }

test('探针结果会被记住并在 /api/settings 中可见（桩驱动 => driver_is_stub）', async (t) => {
  const { base } = await boot(t)
  const before = await (await fetch(`${base}/api/settings`, { headers: H })).json()
  assert.equal(before.lastProbe, null, '还没探过时为空')

  const r = await fetch(`${base}/api/model/probe`, { method: 'POST', headers: H })
  assert.equal(r.status, 400)

  const after = await (await fetch(`${base}/api/settings`, { headers: H })).json()
  assert.ok(after.lastProbe, '探过之后要有记录')
  assert.equal(after.lastProbe.ok, false)
  assert.equal(after.lastProbe.error, 'driver_is_stub')
  assert.ok(after.lastProbe.at, '要有时间戳')
})
