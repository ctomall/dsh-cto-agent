import test from 'node:test'
import assert from 'node:assert/strict'
import { createGrants } from '../src/grants.mjs'
import { openDb, seedTwoTenants } from '../src/db.mjs'

test('会话授权只在 (tenant, session, tool) 三元组内命中', () => {
  const db = openDb(); seedTwoTenants(db)
  const g = createGrants(db)
  g.add({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' })

  assert.equal(g.has({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' }), true, '同租户同会话同工具 → 命中')
  assert.equal(g.has({ tenantId: 't_b', sessionId: 's_x', tool: 'fs.write' }), false, '跨租户不得继承（即使 sessionId 相同）')
  assert.equal(g.has({ tenantId: 't_a', sessionId: 's_y', tool: 'fs.write' }), false, '跨会话不得继承')
  assert.equal(g.has({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.read' }), false, '不同工具不得继承')
})

test('撤销只影响目标范围，并返回受影响行数', () => {
  const db = openDb(); seedTwoTenants(db)
  const g = createGrants(db)
  g.add({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' })
  g.add({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.read' })
  g.add({ tenantId: 't_b', sessionId: 's_x', tool: 'fs.write' })

  assert.equal(g.revoke({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' }), 1)
  assert.equal(g.has({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' }), false)
  assert.equal(g.has({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.read' }), true, '未被撤销的工具仍在')
  assert.equal(g.has({ tenantId: 't_b', sessionId: 's_x', tool: 'fs.write' }), true, '别的租户不受影响')
})

test('list 只返回本租户本会话的授权', () => {
  const db = openDb(); seedTwoTenants(db)
  const g = createGrants(db)
  g.add({ tenantId: 't_a', sessionId: 's_x', tool: 'fs.write' })
  g.add({ tenantId: 't_b', sessionId: 's_x', tool: 'fs.write' })
  const rows = g.list({ tenantId: 't_a', sessionId: 's_x' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'fs.write')
  assert.equal(rows[0].scope, 'session')
})
