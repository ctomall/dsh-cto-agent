import test from 'node:test'
import assert from 'node:assert/strict'

// 没人理的待审批不能永久占着：超过 TTL 必须被判过期（canceled），并删掉快照，
// 否则界面上是一张"点不动的僵尸卡"，而审批接口只会回 no_pending_approval。
test('启动时清理过期审批快照：run → canceled(approval_expired)，快照删除', async (t) => {
  process.env.APPROVAL_TTL_HOURS = '1'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const old = new Date(Date.now() - 3 * 3600_000).toISOString()
  const fresh = new Date().toISOString()
  for (const [rid, when] of [['r_old', old], ['r_new', fresh]]) {
    db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
      .run(rid, 'waiting_approval', when, 't_a', 's_a1')
    db.prepare('insert into run_pending (run_id,tenant_id,session_id,messages_json,call_json,call_id,steps,created_at) values (?,?,?,?,?,?,?,?)')
      .run(rid, 't_a', 's_a1', '[]', JSON.stringify({ id: 'c1', name: 'fs.write', args: {} }), 'c1', 1, when)
  }
  const app = createApp(db) // 启动收敛在这里跑
  t.after(() => { app.close(); delete process.env.APPROVAL_TTL_HOURS })

  const o = db.prepare('select status from runs where id = ?').get('r_old')
  assert.equal(o.status, 'canceled', '过期的那条应被取消')
  assert.equal(db.prepare('select count(*) c from run_pending where run_id = ?').get('r_old').c, 0, '快照应被删除')
  const ev = db.prepare("select payload_json from events where run_id = ? and type = 'run.canceled'").get('r_old')
  assert.ok(ev, '应写入 run.canceled 事件')
  assert.equal(JSON.parse(ev.payload_json).reason, 'approval_expired')

  const n = db.prepare('select status from runs where id = ?').get('r_new')
  assert.equal(n.status, 'waiting_approval', '未过期的必须保留')
  assert.equal(db.prepare('select count(*) c from run_pending where run_id = ?').get('r_new').c, 1, '未过期快照应保留')

  // 审计要有记录
  const audit = db.prepare("select count(*) c from audit_log where action = 'approval_expired'").get().c
  assert.equal(audit, 1)
})
