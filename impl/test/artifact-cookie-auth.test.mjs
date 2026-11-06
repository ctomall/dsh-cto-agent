import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function boot(t) {
  const root = join(tmpdir(), `cube-ck-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(root, 'r_ck'), { recursive: true })
  writeFileSync(join(root, 'r_ck', 'report.md'), '# ok\n')
  process.env.WORKSPACE_ROOT = root
  process.env.APP_PASSWORD = 'pw-test-1'
  process.env.APP_SESSION_SECRET = 'secret-test-1234567890'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_ck', 'done', new Date().toISOString(), 't_a', 's_a1')
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_ck_b', 'done', new Date().toISOString(), 't_b', 's_b1')
  mkdirSync(join(root, 'r_ck_b'), { recursive: true })
  writeFileSync(join(root, 'r_ck_b', 'secret.md'), 'B 的产物')
  const app = createApp(db)
  t.after(() => {
    app.close()
    rmSync(root, { recursive: true, force: true })
    delete process.env.APP_PASSWORD
    delete process.env.APP_SESSION_SECRET
  })
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

async function loginCookie(base) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=pw-test-1',
    redirect: 'manual',
  })
  const sc = r.headers.get('set-cookie') ?? ''
  return sc.split(';')[0]
}

test('产物下载支持 Cookie 身份（公网 Cookie 模式不再 401）', async (t) => {
  const base = await boot(t)
  const cookie = await loginCookie(base)
  assert.match(cookie, /^cube_session=/, `未拿到会话 Cookie：${cookie}`)

  // UI 在 Cookie 模式下拼出的链接：token 为空，只有 Cookie
  const viaCookie = await fetch(`${base}/api/artifacts/r_ck/report.md?token=&inline=1`, { headers: { cookie } })
  assert.equal(viaCookie.status, 200, 'cookie 模式应能取产物')
  assert.match(await viaCookie.text(), /# ok/)

  // 没有任何身份 → 401
  assert.equal((await fetch(`${base}/api/artifacts/r_ck/report.md?token=`)).status, 401)

  // 跨租户仍 404：拿 A 的 Cookie 去取 B 的产物，必须被拒（Cookie 回退不能绕过租户隔离）
  const cross = await fetch(`${base}/api/artifacts/r_ck_b/secret.md?inline=1`, { headers: { cookie } })
  assert.equal(cross.status, 404, '跨租户必须 404')
})
