import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDb, countTables } from '../src/backup.mjs'

test('备份产物可打开，且逐表行数与源库一致', async (t) => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'cube-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const dbPath = join(dir, 'cube.db')
  const db = openDb(dbPath); seedTwoTenants(db)
  db.prepare('insert into sessions (id, tenant_id, user_id, title) values (?,?,?,?)').run('s_1', 't_a', 'u_a', '备份会话')
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)').run('r_1', 'done', new Date().toISOString(), 't_a', 's_1')
  db.prepare('insert into messages (id, tenant_id, session_id, role, content, created_at) values (?,?,?,?,?,?)').run('m_1', 't_a', 's_1', 'user', 'hi', new Date().toISOString())
  db.close()

  const outDir = join(dir, 'bak')
  const r = backupDb({ dbPath, outDir })
  assert.ok(existsSync(r.outPath))
  assert.ok(r.bytes > 0)
  assert.equal(r.verified, true, '源库与副本行数必须一致')
  assert.deepEqual(r.mismatch, [])
  // 断言「与源库一致」而不是写死数字（seed 本身会插入基线数据）
  const src = countTables(dbPath)
  assert.deepEqual(r.counts, src)
  assert.equal(r.counts.runs, 1)
  assert.equal(r.counts.messages, 1)
  assert.ok(r.counts.sessions >= 1)

  // 副本可独立打开并读到数据
  const copy = countTables(r.outPath)
  assert.deepEqual(copy, src)
})

test('目标已存在时拒绝覆盖', async (t) => {
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'cube-backup2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'cube.db')
  openDb(dbPath); const db = openDb(dbPath); seedTwoTenants(db); db.close()

  const fixed = new Date('2026-01-01T00:00:00Z')
  backupDb({ dbPath, outDir: join(dir, 'bak'), now: fixed })
  assert.throws(() => backupDb({ dbPath, outDir: join(dir, 'bak'), now: fixed }), /拒绝覆盖/)
})
