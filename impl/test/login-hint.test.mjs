import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t, env = {}) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

test('口令错误时提示「还可试 N 次」，被限流后提示等待秒数', async (t) => {
  const base = await boot(t, { APP_PASSWORD: 'pw-correct', APP_SESSION_SECRET: 'test-secret-1234567890', RATE_LOGIN_LIMIT: '3' })
  const post = (pw) => fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(pw)}`,
  })

  const first = await post('wrong')
  const html1 = await first.text()
  assert.equal(first.status, 401)
  assert.match(html1, /口令不正确/, '要说明口令错')
  assert.match(html1, /还可试 \d+ 次/, `要说明还剩几次：${html1.slice(0, 200)}`)

  // 打满桶后应 429，并带 retry-after
  for (let i = 0; i < 3; i++) await post('wrong')
  const limited = await post('wrong')
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0, '429 必须带 retry-after')

  // 正确的口令仍能登录（限流过窗口前会被挡，这里只验证限流语义）
  assert.equal((await limited.json()).error, 'rate_limited')
})
