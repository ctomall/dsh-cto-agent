import test from 'node:test'
import assert from 'node:assert/strict'

// 口径：开启口令门（APP_PASSWORD）后，**门看的是 Cookie**，Bearer 只用来确定租户身份。
// 因此"只有 Bearer、没有 Cookie"的请求会被门挡住（401）——这不是 bug，是设计，
// 但必须写清楚，否则集成方会以为 token 能直连。
test('口令门模式下：Bearer 不能单独过门，Cookie 可以；坏 Bearer 仍按 Bearer 判', async (t) => {
  process.env.APP_PASSWORD = 'gate-pw-1'
  process.env.APP_SESSION_SECRET = 'gate-secret-1234567890'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    delete process.env.APP_PASSWORD
    delete process.env.APP_SESSION_SECRET
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  const bearerOnly = await fetch(`${base}/api/sessions`, { headers: { authorization: 'Bearer tok_a' } })
  assert.equal(bearerOnly.status, 401, '只有 Bearer 应被口令门挡住')

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=gate-pw-1',
    redirect: 'manual',
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.startsWith('cube_session='), '登录应下发 Cookie')

  const cookieOnly = await fetch(`${base}/api/sessions`, { headers: { cookie } })
  assert.equal(cookieOnly.status, 200, 'Cookie 应能通过口令门')

  const badBearer = await fetch(`${base}/api/sessions`, { headers: { cookie, authorization: 'Bearer tok_nope' } })
  assert.equal(badBearer.status, 401, '带 Authorization 时以 Bearer 为准：坏的 Bearer 必须 401')
})
