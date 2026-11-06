import test from 'node:test'
import assert from 'node:assert/strict'

// 模块级 env 在 import 时捕获，因此这里先固定 token；IP 白名单是每请求读取，可在用例内改。
process.env.CUBE_UPGRADE_TOKEN = 'right-token'

async function boot(t, env = {}) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

const post = (base, headers = {}) => fetch(`${base}/api/admin/upgrade`, { method: 'POST', headers })

test('升级接口：不带凭据 → 401', async (t) => {
  const base = await boot(t)
  assert.equal((await post(base)).status, 401)
})

test('升级接口：错误凭据 → 401', async (t) => {
  const base = await boot(t)
  assert.equal((await post(base, { 'x-upgrade-token': 'wrong' })).status, 401)
})

test('升级接口：IP 不在白名单 → 403（先于凭据校验）', async (t) => {
  const base = await boot(t, { CUBE_UPGRADE_TOKEN: 'right-token', UPGRADE_ALLOW_IPS: '203.0.113.9' })
  const r = await post(base, { 'x-upgrade-token': 'right-token' })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'ip_not_allowed')
})

test('升级路由：未配置 token → 503（未启用要明说，不能静默放行）', async () => {
  const { createUpgradeRoute } = await import('../src/upgrade.mjs')
  const route = createUpgradeRoute({ token: '', upgradeOnce: async () => ({ ok: true }) })
  assert.equal((await route({ headers: {} })).status, 503)
})
