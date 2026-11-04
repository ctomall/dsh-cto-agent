import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, seedTwoTenants } from '../src/db.mjs'
import { handleRequest } from '../src/server.mjs'

const TOK_A = 'Bearer tok_a'
const TOK_B = 'Bearer tok_b'

function fresh() {
  const db = openDb()
  seedTwoTenants(db)
  return db
}

const get = (db, path, authorization) =>
  handleRequest(db, { method: 'GET', url: path, headers: { authorization } })

test('A 读自己的会话 → 200', () => {
  const r = get(fresh(), '/api/sessions/s_a1', TOK_A)
  assert.equal(r.status, 200)
  assert.equal(r.body.session.id, 's_a1')
})

test('A 读 B 的会话 → 404，且不是 403', () => {
  const r = get(fresh(), '/api/sessions/s_b1', TOK_A)
  assert.equal(r.status, 404)
  assert.notEqual(r.status, 403)
  assert.equal(r.body.error, 'not_found')
})

test('越权响应体不泄露目标租户任何字段', () => {
  const r = get(fresh(), '/api/sessions/s_b1', TOK_A)
  const text = JSON.stringify(r.body)
  assert.equal(text.includes('B 的会话'), false)
  assert.equal(text.includes('t_b'), false)
  assert.equal(text.includes('u_b'), false)
})

test('B 读 A 的会话同样 404（对称）', () => {
  const r = get(fresh(), '/api/sessions/s_a1', TOK_B)
  assert.equal(r.status, 404)
})

test('列表按租户过滤，只返回本租户会话', () => {
  const db = fresh()
  const a = get(db, '/api/sessions', TOK_A)
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.sessions.map((s) => s.id), ['s_a1'])
  const b = get(db, '/api/sessions', TOK_B)
  assert.deepEqual(b.body.sessions.map((s) => s.id), ['s_b1'])
})

test('无 token / 坏 token → 401', () => {
  assert.equal(get(fresh(), '/api/me', undefined).status, 401)
  assert.equal(get(fresh(), '/api/me', 'Bearer nope').status, 401)
  assert.equal(get(fresh(), '/api/me', 'tok_a').status, 401) // 缺 Bearer 前缀
})

test('越权必须落审计行，且能还原三方：谁、目标租户、目标资源', () => {
  const db = fresh()
  get(db, '/api/sessions/s_b1', TOK_A)
  const rows = db.prepare('select * from audit_log').all()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.tenant_id, 't_a')      // 谁（发起方租户）
  assert.equal(row.actor, 'u_a')          // 谁（用户）
  assert.equal(row.action, 'cross_tenant_denied')
  const detail = JSON.parse(row.detail_json)
  assert.equal(detail.resourceId, 's_b1') // 哪个资源
  assert.equal(detail.targetTenantId, 't_b') // 哪个租户
})

test('本租户内的不存在资源 → 404 且不写越权审计', () => {
  const db = fresh()
  const r = get(db, '/api/sessions/s_missing', TOK_A)
  assert.equal(r.status, 404)
  assert.equal(db.prepare('select count(*) c from audit_log').get().c, 0)
})
