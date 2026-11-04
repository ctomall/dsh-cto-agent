import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter, LIMITS, bucketFor, clientIp } from '../src/ratelimit.mjs'

test('滑动窗口：超过上限即拒绝，并给出 retryAfter', () => {
  let t = 0
  const rl = createRateLimiter({ clock: () => t })
  assert.equal(rl.check('ip:a', 2, 1000).ok, true)
  assert.equal(rl.check('ip:a', 2, 1000).ok, true)
  const third = rl.check('ip:a', 2, 1000)
  assert.equal(third.ok, false)
  assert.equal(third.retryAfter >= 1, true)
  t = 1001
  assert.equal(rl.check('ip:a', 2, 1000).ok, true, '窗口滑过后应恢复')
})

test('不同 IP / 不同 bucket 互不影响', () => {
  const rl = createRateLimiter()
  rl.check('ip:a:api', 1, 1000)
  assert.equal(rl.check('ip:a:api', 1, 1000).ok, false)
  assert.equal(rl.check('ip:b:api', 1, 1000).ok, true)
  assert.equal(rl.check('ip:a:runs', 1, 1000).ok, true)
})

test('bucket 归类与限制值', () => {
  assert.equal(bucketFor('/api/admin/upgrade', 'POST'), 'upgrade')
  assert.equal(bucketFor('/api/runs', 'POST'), 'runs')
  assert.equal(bucketFor('/api/sessions', 'GET'), 'api')
  assert.equal(bucketFor('/app.js', 'GET'), null)
  assert.equal(LIMITS.upgrade.limit, 3)
})

test('clientIp 优先取 Cloudflare 头', () => {
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.2.3.4' } }), '1.2.3.4')
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' } }), '5.6.7.8')
})

test('HTTP：超过 api 上限返回 429 且带 retry-after', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  let last
  for (let i = 0; i < LIMITS.api.limit + 2; i++) {
    last = await fetch(`${base}/api/version`)
  }
  assert.equal(last.status, 429)
  assert.ok(Number(last.headers.get('retry-after')) >= 1)
  const body = await last.json()
  assert.equal(body.error, 'rate_limited')
})

test('HTTP：升级接口 IP 白名单生效（403）', async (t) => {
  process.env.UPGRADE_ALLOW_IPS = '10.0.0.1'
  process.env.CUBE_UPGRADE_TOKEN = 'tk'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.UPGRADE_ALLOW_IPS; delete process.env.CUBE_UPGRADE_TOKEN })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const r = await fetch(`${base}/api/admin/upgrade`, { method: 'POST', headers: { 'x-upgrade-token': 'tk' } })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'ip_not_allowed')
})

test('登录失败单独限流：5 次/分钟', async (t) => {
  process.env.APP_PASSWORD = 'pw'
  process.env.APP_SESSION_SECRET = 'sk'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.APP_PASSWORD; delete process.env.APP_SESSION_SECRET })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const codes = []
  for (let i = 0; i < 7; i++) {
    const r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong',
      redirect: 'manual',
    })
    codes.push(r.status)
  }
  assert.equal(codes.slice(0, 5).every((c) => c === 401), true)
  assert.deepEqual(codes.slice(5), [429, 429])
})
