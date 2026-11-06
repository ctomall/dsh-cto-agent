import test from 'node:test'
import assert from 'node:assert/strict'


// 真模型上线后要看"结局分布"和"在跑/待审批"，否则只知道创建数、不知道有没有卡住
test('/metrics 暴露 runs_finished_total（按结局）、runs_running、runs_waiting_approval 与并发拒绝数', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_d', 'done', new Date().toISOString(), 't_a', 's_a1')
  const txt = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer tok_a' } })).text()
  assert.match(txt, /runs_finished_total\{status="done"\} \d+/, txt.slice(0, 300))
  assert.match(txt, /runs_running \d+/)
  assert.match(txt, /runs_waiting_approval \d+/)
  assert.match(txt, /run_concurrency_rejected_total \d+/)
})
