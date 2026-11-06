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

// 口令门 + 升级 token 是两层：**有正确 token 但没有会话 Cookie，仍然进不来**。
// 线上实测过这条组合，但此前没有用例（其它用例要么没开 APP_PASSWORD，要么没带 token）。
test('口令门开启时：正确 token 但无 Cookie → 401（门在 token 之前）', async (t) => {
  const base = await boot(t, { APP_PASSWORD: 'pw-x', APP_SESSION_SECRET: 's-x-1234567890' })
  const r = await post(base, { 'x-upgrade-token': 'right-token' })
  assert.equal(r.status, 401, `应被口令门挡住，实际 ${r.status}`)
})

test('口令门开启 + 有 Cookie 但无 token → 401', async (t) => {
  const base = await boot(t, { APP_PASSWORD: 'pw-y', APP_SESSION_SECRET: 's-y-1234567890' })
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=pw-y',
    redirect: 'manual',
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.startsWith('cube_session='), '登录应下发 Cookie')
  const r = await post(base, { cookie })
  assert.equal(r.status, 401, `有 Cookie 无 token 应 401，实际 ${r.status}`)
})
