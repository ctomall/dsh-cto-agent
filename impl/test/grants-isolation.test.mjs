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

test('HTTP：审批"本会话允许"后，/grants 返回真实授权；跨租户 404', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '授权列表' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))

  const before = await (await fetch(`${base}/api/sessions/${sid}/grants`, { headers: H })).json()
  assert.equal(before.grants.length, 0, '授权前应为空')

  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_session' }) })
  const after = await (await fetch(`${base}/api/sessions/${sid}/grants`, { headers: H })).json()
  assert.equal(after.grants.length, 1)
  assert.equal(after.grants[0].tool, 'fs.write')
  assert.equal(after.grants[0].scope, 'session')

  assert.equal((await fetch(`${base}/api/sessions/s_b1/grants`, { headers: H })).status, 404)
})
