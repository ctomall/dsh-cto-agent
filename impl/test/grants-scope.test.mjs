import test from 'node:test'
import assert from 'node:assert/strict'

// approvals.scope 的语义：只有 scope='session' 才免审批。
// 其它 scope 即便表里有行，也不能自动放行（否则"允许一次"会被写成长期授权）。
test('只有 scope=session 的授权会免审批', async () => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { createGrants } = await import('../src/grants.mjs')
  const db = openDb(); seedTwoTenants(db)
  const grants = createGrants(db)

  grants.add({ tenantId: 't_a', sessionId: 's_a1', tool: 'fs.write' })
  assert.equal(grants.has({ tenantId: 't_a', sessionId: 's_a1', tool: 'fs.write' }), true, 'session 授权应命中')

  // 人为塞一条 scope 非 session 的行
  db.prepare('insert or replace into session_grants (tenant_id, session_id, tool, scope, granted_at) values (?,?,?,?,?)')
    .run('t_a', 's_a1', 'fs.read', 'once', new Date().toISOString())
  assert.equal(grants.has({ tenantId: 't_a', sessionId: 's_a1', tool: 'fs.read' }), false, 'scope=once 不应免审批')

  // 跨会话/跨租户不继承（既有语义，再钉一次）
  assert.equal(grants.has({ tenantId: 't_a', sessionId: 's_a2', tool: 'fs.write' }), false, '跨会话不继承')
  assert.equal(grants.has({ tenantId: 't_b', sessionId: 's_a1', tool: 'fs.write' }), false, '跨租户不继承')
})
