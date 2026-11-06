import test from 'node:test'
import assert from 'node:assert/strict'
import { clientIp, createRateLimiter } from '../src/ratelimit.mjs'

test('clientIp：只信受信代理的转发头，直连时忽略伪造的 x-forwarded-for', () => {
  const spoof = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '203.0.113.7' } }
  assert.equal(clientIp(spoof), '203.0.113.7', '非回环直连必须用真实来源，不能信转发头')

  const viaProxy = { headers: { 'cf-connecting-ip': '5.6.7.8', 'x-forwarded-for': '5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(clientIp(viaProxy), '5.6.7.8', '回环（cloudflared）时信任转发头')

  const noHeader = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(clientIp(noHeader), '127.0.0.1')
})

test('限流器：伪造来源不会让键无限增长（有上限）', () => {
  const rl = createRateLimiter({ clock: () => 1000, maxKeys: 50 })
  for (let i = 0; i < 500; i++) rl.check(`10.0.0.${i}:api`, 60, 60_000)
  assert.ok(rl.size <= 50, `键数量应被限制在 50，实际 ${rl.size}`)
})

test('请求体超限 → 413（按 content-length 拒绝，不读入内存）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  const big = 'x'.repeat(2 * 1024 * 1024)
  const r = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok_a' },
    body: JSON.stringify({ title: big }),
  })
  assert.equal(r.status, 413)
  assert.equal((await r.json()).error, 'payload_too_large')
})
