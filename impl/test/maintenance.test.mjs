import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbStats, pruneEvents } from '../src/maintenance.mjs'

test('统计：返回体积与各表行数', async (t) => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'mnt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'cube.db')
  const db = openDb(dbPath); seedTwoTenants(db); db.close()

  const s = dbStats(dbPath)
  assert.ok(s.bytes > 0)
  assert.equal(s.tables.tenants, 2)
  assert.ok('events' in s.tables)
})

test('清理事件：只删终态 run 的旧事件，活跃 run 与审计都保留', async (t) => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'mnt2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'cube.db')
  const db = openDb(dbPath); seedTwoTenants(db)
  const old = new Date(Date.now() - 90 * 86400000).toISOString()

  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)').run('r_done', 'done', old, 't_a', 's_a1')
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)').run('r_live', 'waiting_approval', old, 't_a', 's_a1')
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)').run('r_done', 1, 'text.delta', '{}', old)
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)').run('r_live', 1, 'text.delta', '{}', old)
  db.prepare('insert into audit_log (tenant_id,actor,action,detail_json,ts) values (?,?,?,?,?)').run('t_a', 'u_a', 'x', '{}', old)
  db.close()

  const r = pruneEvents(dbPath, { days: 30 })
  assert.equal(r.deleted, 1, '只应删除终态 run 的旧事件')

  const check = openDb(dbPath)
  t.after(() => check.close())
  assert.equal(check.prepare('select count(*) c from events where run_id = ?').get('r_done').c, 0)
  assert.equal(check.prepare('select count(*) c from events where run_id = ?').get('r_live').c, 1, '活跃 run 的事件必须保留')
  assert.equal(check.prepare('select count(*) c from audit_log').get().c, 1, '审计永不删')
})
