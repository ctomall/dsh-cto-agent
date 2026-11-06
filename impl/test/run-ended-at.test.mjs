import test from 'node:test'
import assert from 'node:assert/strict'

// ended_at 语义：任何终态都要写，否则时长/收尾统计只覆盖"失败"这一种情况。
test('run 进入终态时写入 ended_at（done / canceled 都覆盖）', async (t) => {
  process.env.RUN_CREATE_WAIT_MS = '8000'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RUN_CREATE_WAIT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'ended_at' }) })).json()

  // 1) 走到 done
  const a = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '读一下 a.md', sessionId: sid }) })).json()
  for (let i = 0; i < 40; i++) {
    const st = db.prepare('select status from runs where id = ?').get(a.runId)?.status
    if (st === 'done' || st === 'failed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const doneRow = db.prepare('select status, ended_at from runs where id = ?').get(a.runId)
  assert.equal(doneRow.status, 'done')
  assert.ok(doneRow.ended_at, `done 的 run 应写 ended_at，实际 ${doneRow.ended_at}`)

  // 2) 走到 canceled
  const b = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await fetch(`${base}/api/runs/${b.runId}/cancel`, { method: 'POST', headers: H, body: '{}' })
  const cancelRow = db.prepare('select status, ended_at from runs where id = ?').get(b.runId)
  assert.equal(cancelRow.status, 'canceled')
  assert.ok(cancelRow.ended_at, `canceled 的 run 应写 ended_at，实际 ${cancelRow.ended_at}`)
})
