import test from 'node:test'
import assert from 'node:assert/strict'

async function boot(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}` }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

async function makeArtifact(base) {
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '产物页' }) })).json()
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await new Promise((r) => setTimeout(r, 200))
  await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  await new Promise((r) => setTimeout(r, 300))
  return { sid, runId }
}

test('产物页：/artifacts 返回页面，/api/artifacts 跨会话列出产物', async (t) => {
  const { base } = await boot(t)
  const { sid, runId } = await makeArtifact(base)

  const page = await fetch(`${base}/artifacts`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /id="list"/, '页面要有列表容器')
  assert.match(html, /artifacts\.js/, '页面要加载脚本')

  const r = await fetch(`${base}/api/artifacts?limit=50`, { headers: H })
  assert.equal(r.status, 200)
  const { artifacts } = await r.json()
  assert.ok(artifacts.length >= 1)
  const mine = artifacts.find((a) => a.runId === runId)
  assert.ok(mine, '应包含刚生成的产物')
  assert.equal(mine.sessionId, sid)
  assert.ok(mine.path.endsWith('report.md'))
})

test('产物页数据按租户隔离：B 看不到 A 的产物', async (t) => {
  const { base } = await boot(t)
  await makeArtifact(base)
  const b = await (await fetch(`${base}/api/artifacts`, { headers: { authorization: 'Bearer tok_b' } })).json()
  assert.equal(b.artifacts.length, 0)
})
