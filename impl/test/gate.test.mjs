import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t, env = {}) {
  Object.assign(process.env, env)
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    for (const k of Object.keys(env)) delete process.env[k]
  })
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db }
}

test('未配置 APP_PASSWORD：身份门关闭，页面直接可访问', async (t) => {
  const { base } = await boot(t)
  const r = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(r.status, 200)
})

test('开启身份门：页面 302 到 /login，API 返回 401', async (t) => {
  const { base } = await boot(t, { APP_PASSWORD: 's3cret', APP_SESSION_SECRET: 'k1' })
  const page = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(page.status, 302)
  assert.equal(page.headers.get('location'), '/login')

  const api = await fetch(`${base}/api/sessions`, { headers: { authorization: 'Bearer tok_a' } })
  assert.equal(api.status, 401)

  const login = await fetch(`${base}/login`)
  assert.equal(login.status, 200)
  assert.match(await login.text(), /输入访问口令/)
})

test('探活与版本在身份门开启时仍可访问', async (t) => {
  const { base } = await boot(t, { APP_PASSWORD: 's3cret', APP_SESSION_SECRET: 'k2' })
  assert.equal((await fetch(`${base}/api/version`)).status, 200)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
})

test('口令错误 401，正确则下发 Cookie 并放行', async (t) => {
  const { base } = await boot(t, { APP_PASSWORD: 's3cret', APP_SESSION_SECRET: 'k3' })
  const bad = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
    redirect: 'manual',
  })
  assert.equal(bad.status, 401)

  const good = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=s3cret',
    redirect: 'manual',
  })
  assert.equal(good.status, 302)
  const cookie = good.headers.get('set-cookie').split(';')[0]
  assert.match(cookie, /^cube_session=[0-9a-f]{64}$/)

  const page = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(page.status, 200)
  const api = await fetch(`${base}/api/me`, { headers: { cookie, authorization: 'Bearer tok_a' } })
  assert.equal(api.status, 200)
})

test('伪造 Cookie 不放行', async (t) => {
  const { base } = await boot(t, { APP_PASSWORD: 's3cret', APP_SESSION_SECRET: 'k4' })
  const r = await fetch(`${base}/`, { headers: { cookie: 'cube_session=deadbeef' }, redirect: 'manual' })
  assert.equal(r.status, 302)
})
