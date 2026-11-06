import test from 'node:test'
import assert from 'node:assert/strict'

test('还原待审批卡片时也会带 argsTruncated（否则刷新后看不到"已截断"提示）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { authorization: 'Bearer tok_a' }
  const now = new Date().toISOString()

  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_pd', 'waiting_approval', now, 't_a', 's_a1')
  db.prepare('insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)')
    .run('r_pd', 1, 'approval.requested', JSON.stringify({
      callId: 'c1', action: 'fs.write', target: 'big.md', impact: '写入', args: { path: 'big.md', content: 'A'.repeat(80) + '…（共 5000 字，已截断）' }, argsTruncated: true,
    }), now)

  const r = await (await fetch(`${base}/api/sessions/s_a1/pending`, { headers: H })).json()
  const item = (r.pending ?? []).find((p) => p.runId === 'r_pd')
  assert.ok(item, '应返回该待审批项')
  assert.equal(item.argsTruncated, true, 'pending 必须带 argsTruncated')
  assert.match(String(item.args.content), /已截断/)
})
