import test from 'node:test'
import assert from 'node:assert/strict'

// 轻量 SQL 注入 fuzz：所有外部可控输入都走参数绑定，载荷不应造成 5xx 或破坏库结构
const PAYLOADS = [
  "' or 1=1--",
  "'; drop table runs;--",
  '" or ""="',
  "1 union select * from audit_log",
  "1;update runs set status='done'",
  "'||(select 1)||'",
]

async function boot(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db }
}
const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

test('查询参数与路径参数里的 SQL 载荷：不 5xx、不泄漏 SQL 报错、库结构完好', async (t) => {
  const { base, db } = await boot(t)
  // 先造一条真实数据，作为"注入是否真的改了东西"的对照
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'sqli' }) })).json()
  const before = db.prepare('select count(*) c from runs').get().c

  for (const p of PAYLOADS) {
    const enc = encodeURIComponent(p)
    const urls = [
      `${base}/api/audit?limit=${enc}`,
      `${base}/api/artifacts?limit=${enc}`,
      `${base}/api/sessions/${enc}/pending`,
      `${base}/api/sessions/${enc}`,
    ]
    for (const url of urls) {
      const r = await fetch(url, { headers: H })
      const body = await r.text().catch(() => '')
      assert.ok(r.status < 500, `${url} 不应 5xx（实际 ${r.status}）`)
      assert.ok(!/syntax error|no such table|SQLITE_/i.test(body), `${url} 泄漏了 SQL 细节：${body.slice(0, 120)}`)
    }
  }

  // 会话 id 里带载荷也不能绕过租户隔离：跨租户仍 404
  for (const p of PAYLOADS) {
    const r = await fetch(`${base}/api/sessions/${encodeURIComponent(p)}`, { headers: { authorization: 'Bearer tok_b' } })
    assert.equal(r.status, 404, `跨租户读取载荷 ${p} 应 404，实际 ${r.status}`)
  }

  // 注入没有真的改动数据
  assert.equal(db.prepare('select count(*) c from runs').get().c, before, 'runs 行数不应变化')
  assert.ok(db.prepare('select count(*) c from audit_log').get().c >= 0, 'audit_log 表仍可用')
  assert.equal(db.prepare('select title from sessions where id = ?').get(sid).title, 'sqli', '原数据未被改写')
})

test('请求体里的载荷：sessionId 注入不影响其它租户数据', async (t) => {
  const { base, db } = await boot(t)
  for (const p of PAYLOADS) {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ input: 'x', sessionId: p }),
    })
    assert.ok(r.status < 500, `sessionId=${p} 不应 5xx（实际 ${r.status}）`)
  }
  assert.equal(db.prepare("select count(*) c from runs where tenant_id = 't_b'").get().c, 0, '未在其它租户下创建 run')
})

test('limit 参数被钳制（NaN→默认、0→1、超大→上限），不是"注入成功"', async (t) => {
  const { base } = await boot(t)
  const rows = (n, url) => url
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: `s${i}` }) })
  }
  const get = async (u) => (await fetch(`${base}${u}`, { headers: H })).json()

  const nan = await get('/api/audit?limit=not-a-number')
  assert.ok(Array.isArray(nan.audit), 'NaN 应回落到默认而不是报错')
  assert.equal(nan.limit, 50, 'NaN → 默认 50')
  const zero = await get('/api/audit?limit=0')
  assert.equal(zero.limit, 1, 'limit=0 被钳到 1')
  const huge = await get('/api/audit?limit=99999')
  assert.equal(huge.limit, 200, '超大 limit 钳到上限 200')
  const big = await get('/api/artifacts?limit=99999')
  assert.ok(big.artifacts.length <= 500, '超大 limit 必须被钳到 500 以内')

  // 载荷型 limit 不应报 5xx（已在上一用例覆盖），这里确认仍返回数组
  const inj = await get(`/api/artifacts?limit=${encodeURIComponent("1 union select * from audit_log")}`)
  assert.ok(Array.isArray(inj.artifacts), '载荷型 limit 应回落到默认并返回数组')
  assert.equal(inj.limit, 100, '载荷型 limit → 默认 100')
})
