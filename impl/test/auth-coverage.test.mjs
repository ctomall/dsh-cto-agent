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

test('正则式路由族（/api/…/:id 等）未鉴权同样不得返回 200', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  process.env.APP_PASSWORD = 'pw-route-2'
  process.env.APP_SESSION_SECRET = 'route-secret-2-1234567'
  const app = createApp(db)
  t.after(() => {
    app.close()
    delete process.env.APP_PASSWORD
    delete process.env.APP_SESSION_SECRET
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  const src = await (await import('node:fs/promises')).readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  // 不解析正则本身（太脆）：先把源码里的转义反斜杠去掉，再抽 /api/... 静态前缀
  const flat = src.replace(/\\/g, '')
  const prefixes = new Set()
  for (const m of flat.matchAll(/\/api\/[A-Za-z0-9_\/-]+/g)) {
    const p = m[0].replace(/\/$/, '')
    // 明确允许匿名访问的（探活/版本/登录）不进本轮检查
    if ([...ANON_OK].some((a) => p === a || p.startsWith(a + '/'))) continue
    if (p.split('/').length >= 3) prefixes.add(p)
  }
  assert.ok(prefixes.size >= 5, `路由前缀枚举异常，只找到 ${prefixes.size} 个`)

  const leaked = []
  for (const p of prefixes) {
    for (const probe of [p, `${p}/x`, `${p}/x/y`]) {
      const res = await fetch(`${base}${probe}`, { redirect: 'manual' })
      if (res.status === 200) leaked.push(`${probe} → 200`)
    }
  }
  assert.deepEqual(leaked, [], `未鉴权却返回 200 的正则路由：${leaked.join(', ')}`)
})
