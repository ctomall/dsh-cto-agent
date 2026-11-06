import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用文件库，模拟"进程重启"：同一个 DB 上先后创建两个 app 实例
async function makeApp(db) {
  const { createApp } = await import('../src/server.mjs')
  const app = createApp(db)
  await new Promise((r) => app.listen(0, r))
  return { app, base: `http://127.0.0.1:${app.address().port}` }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('审批快照落库：重启后仍可审批并跑完', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cube-pending-'))
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const dbPath = join(dir, 'cube.db')
  const db = openDb(dbPath)
  seedTwoTenants(db)

  const a1 = await makeApp(db)
  const { id: sid } = await (await fetch(`${a1.base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '重启恢复' }) })).json()

  // 跑到审批挂起
  const { runId } = await (await fetch(`${a1.base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  const pendingRow = db.prepare('select count(*) c from run_pending where run_id = ?').get(runId).c
  assert.equal(pendingRow, 1, '挂起时必须落库')
  assert.equal(db.prepare('select status from runs where id = ?').get(runId).status, 'waiting_approval')

  // 「重启」：关闭旧 app，用同一个库新建 app（内存态全部丢失）
  a1.app.close()
  const a2 = await makeApp(db)
  t.after(() => { a2.app.close(); rmSync(dir, { recursive: true, force: true }) })

  // 收敛逻辑不能把它标 failed
  assert.equal(db.prepare('select status from runs where id = ?').get(runId).status, 'waiting_approval', '有快照的 run 不能被收敛成 failed')

  // 重启后照样能审批并跑完
  const done = await (await fetch(`${a2.base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })).json()
  assert.equal(done.status, 'done')
  assert.equal(db.prepare('select count(*) c from run_pending where run_id = ?').get(runId).c, 0, '审批完成后快照必须清理')
})

test('没有快照的遗留 run 仍会被收敛为 failed', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?,?,?,?,?)')
    .run('r_nosnap', 'waiting_approval', new Date().toISOString(), 't_a', 's_a1')
  const app = createApp(db)
  t.after(() => app.close())
  assert.equal(db.prepare('select status from runs where id = ?').get('r_nosnap').status, 'failed')
})

test('取消待审批的 run：快照被清理，之后再审批返回 already_terminal 而不是 500', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '取消清快照' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(db.prepare('select count(*) c from run_pending where run_id = ?').get(runId).c, 1, '挂起时应有快照')

  const cn = await (await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: H })).json()
  assert.equal(cn.status, 'canceled')
  assert.equal(db.prepare('select count(*) c from run_pending where run_id = ?').get(runId).c, 0, '取消后快照必须清理')

  const ap = await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  assert.equal(ap.status, 200, '再审批不应 500')
  assert.equal((await ap.json()).note, 'already_terminal')
})
