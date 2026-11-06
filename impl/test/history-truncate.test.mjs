import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

// 长会话保护：单条消息过长会撑爆上下文，发送给模型时必须截断并标注
test('loadHistory 会把超长消息截断后再发给模型（库内原文不动）', async (t) => {
  const bodies = []
  const mock = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((r) => mock.listen(0, r))
  const port = mock.address().port
  t.after(() => mock.close())

  const env = {
    MODEL_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    MODEL_NAME: 'mock',
    MODEL_API_KEY: 'sk-test',
    AGENT_HISTORY_CHARS: '50',
  }
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }

  const url = pathToFileURL(new URL('../src/server.mjs', import.meta.url).pathname).href + `?v=${Date.now()}`
  const { createApp } = await import(url)
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => {
    app.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '长消息' }) })).json()
  const long = 'x'.repeat(500)
  db.prepare('insert into messages (tenant_id, session_id, role, content, created_at) values (?,?,?,?,?)')
    .run('t_a', sid, 'user', long, new Date().toISOString())

  await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '继续', sessionId: sid }) })
  await new Promise((r) => setTimeout(r, 600))

  assert.ok(bodies.length >= 1, '模型应收到请求')
  const sent = JSON.stringify(bodies[0])
  assert.ok(sent.includes('已截断'), `发送内容应带截断标注：${sent.slice(0, 200)}`)
  assert.ok(!sent.includes('x'.repeat(500)), '不应把 500 字原文整段发出')

  const row = db.prepare('select content from messages where session_id = ? and role = ?').get(sid, 'user')
  assert.equal(row.content.length, 500, '库内原文不能被改写')
})
