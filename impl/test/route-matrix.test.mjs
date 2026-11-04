import test from 'node:test'
import assert from 'node:assert/strict'

// 路由暴露矩阵：逐条断言"未授权时不该通"。防止新加接口忘了套门禁。
const PUBLIC = new Set(['/login', '/api/version', '/healthz'])

const ROUTES = [
  ['GET', '/'],
  ['GET', '/app.js'],
  ['GET', '/app.css'],
  ['GET', '/metrics'],
  ['GET', '/api/version'],
  ['GET', '/healthz'],
  ['GET', '/api/me'],
  ['GET', '/api/sessions'],
  ['GET', '/api/sessions/s_a1'],
  ['GET', '/api/model/status'],
  ['GET', '/api/runs/x/events'],
  ['POST', '/api/runs'],
  ['POST', '/api/sessions'],
  ['POST', '/api/sessions/s_a1/grants/revoke'],
  ['POST', '/api/approvals/x'],
  ['POST', '/api/admin/upgrade'],
]

async function call(base, method, path) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 3000) // 任何一条路由都不许挂住测试
  try {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    })
    return res.status
  } catch (e) {
    return `HANG(${e.name})`
  } finally {
    clearTimeout(timer)
  }
}

async function boot(t, env) {
  Object.assign(process.env, env)
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); for (const k of Object.keys(env)) delete process.env[k] })
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

test('身份门开启：除公开端点外，未授权一律 302/401', async (t) => {
  const base = await boot(t, { APP_PASSWORD: 'p', APP_SESSION_SECRET: 's' })
  const failures = []
  for (const [method, path] of ROUTES) {
    const status = await call(base, method, path)
    if (PUBLIC.has(path)) {
      if (![200, 201, 400, 404, 405].includes(status)) failures.push(`${method} ${path} → ${status}（公开端点应可达）`)
    } else if (![302, 401].includes(status)) {
      failures.push(`${method} ${path} → ${status}（应 302 或 401）`)
    }
  }
  assert.deepEqual(failures, [])
})

test('身份门关闭：API 仍需 token，未带 token 一律 401', async (t) => {
  const base = await boot(t, {})
  const failures = []
  for (const [method, path] of ROUTES) {
    if (!path.startsWith('/api/') || PUBLIC.has(path)) continue
    const status = await call(base, method, path)
    // 503 = 升级接口未配置 token 时的 fail-closed，属预期
    if (![401, 403, 404, 503].includes(status)) failures.push(`${method} ${path} → ${status}`)
  }
  assert.deepEqual(failures, [])
})
