import test from 'node:test'
import assert from 'node:assert/strict'

// 为将来接入 Cloudflare Access 预留的安全断言：
// 边缘身份头（Cf-Access-*）在**没有 JWT 校验**的情况下绝不能被当作身份，
// 否则任何直连源站的人都能伪造一个邮箱拿到权限。
test('伪造的 Cloudflare Access 身份头不能通过身份门', async (t) => {
  process.env.APP_PASSWORD = 'pw-cf-1'
  process.env.APP_SESSION_SECRET = 'cf-secret-1234567890'
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

  const forged = {
    'cf-access-authenticated-user-email': 'ceo@example.com',
    'cf-access-jwt-assertion': 'fake.jwt.token',
    'cf-connecting-ip': '203.0.113.9',
  }

  for (const path of ['/api/sessions', '/api/overview', '/api/settings']) {
    const r = await fetch(`${base}${path}`, { headers: forged })
    assert.equal(r.status, 401, `${path} 不应因伪造边缘头而放行`)
  }
  const page = await fetch(`${base}/`, { headers: forged, redirect: 'manual' })
  assert.equal(page.status, 302, '首页应仍跳登录')

  // 合法 Cookie 仍然有效（不能因为加了这条断言把正常路径也挡了）
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=pw-cf-1',
    redirect: 'manual',
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const ok = await fetch(`${base}/api/sessions`, { headers: { cookie } })
  assert.equal(ok.status, 200, '口令门 Cookie 仍应放行')
})
