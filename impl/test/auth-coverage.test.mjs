import test from 'node:test'
import assert from 'node:assert/strict'

// 防"新增路由忘了鉴权"：从源码里枚举所有路由，逐个断言未带凭据时被挡住。
// 允许匿名访问的只有明确列出的几个（探活/版本/登录/静态资源）。
const ANON_OK = new Set([
  '/healthz',    // 探活
  '/api/version', // 只暴露启动 SHA
  '/login',      // 登录页本身
])

test('所有 /api 路由与页面路由：未带凭据一律被挡住（除明确白名单）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  process.env.APP_PASSWORD = 'pw-route-1'
  process.env.APP_SESSION_SECRET = 'route-secret-1234567890'
  const app = createApp(db)
  t.after(() => {
    app.close()
    delete process.env.APP_PASSWORD
    delete process.env.APP_SESSION_SECRET
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  // 路由清单直接来自源码，避免"加了新路由但清单没更新"
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  const routes = [...new Set([...src.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]))]
  assert.ok(routes.length >= 15, `路由枚举异常，只找到 ${routes.length} 个`)

  const leaked = []
  for (const r of routes) {
    if (ANON_OK.has(r)) continue
    const res = await fetch(`${base}${r}`, { redirect: 'manual' })
    // 允许 401/403/404（不泄露是否存在），但**绝不能 200**
    if (res.status === 200) leaked.push(`${r} → 200`)
  }
  assert.deepEqual(leaked, [], `未鉴权却返回 200 的路由：${leaked.join(', ')}`)
})
