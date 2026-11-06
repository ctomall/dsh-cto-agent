import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, seedTwoTenants } from '../src/db.mjs'

test('落盘库：关掉再打开，数据仍在；种子幂等不重复', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cube-db-'))
  const path = join(dir, 'cube.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let db = openDb(path)
  seedTwoTenants(db)
  db.prepare("insert into sessions (id, tenant_id, user_id, title) values ('s_persist','t_a','u_a','落盘会话')").run()
  db.close()

  db = openDb(path)
  seedTwoTenants(db) // 幂等
  const row = db.prepare("select title from sessions where id = 's_persist'").get()
  assert.equal(row.title, '落盘会话')
  const tenants = db.prepare('select count(*) c from tenants').get()
  assert.equal(Number(tenants.c), 2, '种子不应重复灌入')
  db.close()
})

test('启动收敛：上个进程遗留的 waiting_approval 会被标记 failed 并写审计', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)

  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_stale', 'waiting_approval', new Date().toISOString(), 't_a', 's_a1')
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_run', 'running', new Date().toISOString(), 't_a', 's_a1')

  const app = createApp(db)
  t.after(() => app.close())

  assert.equal(db.prepare('select status from runs where id = ?').get('r_stale').status, 'failed')
  assert.equal(db.prepare('select status from runs where id = ?').get('r_run').status, 'failed')
  const audited = db.prepare("select count(*) c from audit_log where action = 'run_interrupted'").get().c
  assert.equal(audited, 2)
  const failedEvents = db.prepare("select count(*) c from events where type = 'run.failed'").get().c
  assert.equal(failedEvents, 2, '每个被收敛的 run 都要留下 run.failed 事件')
})

test('保留策略：启动时清理超过 RETENTION_DAYS 的工具结果', async (t) => {
  process.env.RETENTION_DAYS = '30'
  t.after(() => { delete process.env.RETENTION_DAYS })
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)

  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  const fresh = new Date().toISOString()
  db.prepare('insert into run_tool_results (run_id, call_id, ok, content, created_at) values (?,?,?,?,?)').run('r_old', 'c1', 1, 'x', old)
  db.prepare('insert into run_tool_results (run_id, call_id, ok, content, created_at) values (?,?,?,?,?)').run('r_new', 'c1', 1, 'y', fresh)

  const app = createApp(db)
  t.after(() => app.close())

  assert.equal(db.prepare('select count(*) c from run_tool_results where run_id = ?').get('r_old').c, 0, '过期数据应被清理')
  assert.equal(db.prepare('select count(*) c from run_tool_results where run_id = ?').get('r_new').c, 1, '未过期数据必须保留')
})
