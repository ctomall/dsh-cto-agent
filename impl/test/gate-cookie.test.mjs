import test from 'node:test'
import assert from 'node:assert/strict'

async function bootGate(t) {
  process.env.APP_PASSWORD = 'pw-test'
  process.env.APP_SESSION_SECRET = 'secret-test'
  t.after(() => { delete process.env.APP_PASSWORD; delete process.env.APP_SESSION_SECRET })

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

async function login(base) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=pw-test',
    redirect: 'manual',
  })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  return { status: r.status, cookie }
}

test('口令门：通过后 Cookie 即可调用 API（无需 Bearer token）', async (t) => {
  const base = await bootGate(t)
  const { status, cookie } = await login(base)
  assert.equal(status, 302)
  assert.match(cookie, /^cube_session=/)

  const me = await fetch(`${base}/api/me`, { headers: { cookie } })
  assert.equal(me.status, 200)
  const body = await me.json()
  assert.equal(body.tenantId, 't_a', 'Cookie 身份映射到 GATE_TENANT')
})

test('口令门：没有 Cookie 也没有 Bearer → 401', async (t) => {
  const base = await bootGate(t)
  assert.equal((await fetch(`${base}/api/me`)).status, 401)
})

test('CSRF：Cookie 身份 + 跨站变更请求 → 403', async (t) => {
  const base = await bootGate(t)
  const { cookie } = await login(base)
  const r = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ title: 'csrf' }),
  })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'csrf_blocked')
})

test('CSRF：同源变更请求照常通过', async (t) => {
  const base = await bootGate(t)
  const { cookie } = await login(base)
  const r = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ title: 'ok' }),
  })
  assert.equal(r.status, 201)
})
