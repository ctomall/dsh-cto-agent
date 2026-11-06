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

test('/api/settings：未登录 401；登录后返回运行时配置且不含任何密钥字段', async (t) => {
  const { base } = await boot(t)
  assert.equal((await fetch(`${base}/api/settings`)).status, 401)

  const r = await fetch(`${base}/api/settings`, { headers: { authorization: 'Bearer tok_a' } })
  assert.equal(r.status, 200)
  const b = await r.json()
  assert.ok(b.driver?.name, '应有驱动信息')
  assert.equal(typeof b.driver.real, 'boolean')
  assert.ok(b.limits?.api?.limit > 0)
  assert.ok(b.maxBodyBytes > 0)

  const raw = JSON.stringify(b).toLowerCase()
  for (const bad of ['password', 'api_key', 'apikey', 'secret', 'dbpath', 'db_path']) {
    assert.ok(!raw.includes(bad), `响应不应包含 ${bad}`)
  }
  // 更硬的断言：真实密钥值（而非关键词）绝不能出现在响应里
  const secretValues = [
    process.env.CUBE_TOKENS,
    process.env.APP_PASSWORD,
    process.env.APP_SESSION_SECRET,
    process.env.MODEL_API_KEY,
  ].filter((v) => typeof v === 'string' && v.length >= 8)
  for (const v of secretValues) {
    assert.ok(!JSON.stringify(b).includes(v), '响应泄露了真实密钥值')
  }
})

test('/settings 页面可访问且包含列表容器与脚本', async (t) => {
  const { base } = await boot(t)
  const r = await fetch(`${base}/settings`)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /id="list"/)
  assert.match(html, /settings\.js/)
})
