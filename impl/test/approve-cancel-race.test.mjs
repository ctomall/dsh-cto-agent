import test from 'node:test'
import assert from 'node:assert/strict'

// 批准与取消同时到达：终态必须唯一、且终态之后不再有事件。
test('批准与取消并发：终态唯一、终态之后无事件（重复 8 次）', async (t) => {
  process.env.RUN_CREATE_WAIT_MS = '8000'
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => { app.close(); delete process.env.RUN_CREATE_WAIT_MS })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  for (let round = 1; round <= 8; round++) {
    const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: `竞态${round}` }) })).json()
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()

    // 同时：批准 + 取消
    await Promise.all([
      fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) }),
      fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: H, body: '{}' }),
    ])

    // 等收敛
    let txt = ''
    for (let i = 0; i < 60; i++) {
      txt = await (await fetch(`${base}/api/runs/${runId}/events?replay=1`, { headers: { authorization: 'Bearer tok_a' } })).text()
      if (txt.includes('run.finished') || txt.includes('run.failed') || txt.includes('run.canceled')) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const seqs = [...txt.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    const types = [...txt.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    const terminals = types.filter((x) => ['run.finished', 'run.failed', 'run.canceled'].includes(x))
    assert.equal(terminals.length, 1, `第 ${round} 轮终态应唯一，实际 ${terminals.join(',')}；序列=${types.join(' ')}`)
    const lastType = types[types.length - 1]
    assert.ok(['run.finished', 'run.failed', 'run.canceled'].includes(lastType), `第 ${round} 轮终态后还有事件：${lastType}；序列=${types.join(' ')}`)
    // 序号严格递增（乱序会让前端 Last-Event-ID 续传错乱）
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `第 ${round} 轮事件序号不递增：${seqs.join(',')}`)
  }
})
