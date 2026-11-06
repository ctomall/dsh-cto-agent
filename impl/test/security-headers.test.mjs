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

test('所有响应都带安全头（页面/API/错误）', async (t) => {
  const { base } = await boot(t)
  const cases = [
    ['/', await fetch(`${base}/`)],
    ['/api/version', await fetch(`${base}/api/version`)],
    ['/api/sessions 未登录', await fetch(`${base}/api/sessions`)],
    ['/login', await fetch(`${base}/login`)],
  ]
  for (const [label, r] of cases) {
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, `${label} 缺 CSP`)
    assert.equal(r.headers.get('x-frame-options'), 'DENY', `${label} 缺 X-Frame-Options`)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${label} 缺 nosniff`)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', `${label} 缺 Referrer-Policy`)
  }
})

test('CSP 不允许第三方脚本源（只允许 self）', async (t) => {
  const { base } = await boot(t)
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? ''
  assert.match(csp, /script-src 'self'/)
  assert.ok(!/script-src[^;]*\*/.test(csp), 'CSP 不应允许通配源')
  assert.ok(!/unsafe-inline/.test(csp), 'CSP 不应允许内联脚本/样式')
})
