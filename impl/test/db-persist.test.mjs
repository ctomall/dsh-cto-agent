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
