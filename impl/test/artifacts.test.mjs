import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function boot(t) {
  const root = mkdtempSync(join(tmpdir(), 'cube-art-'))
  process.env.WORKSPACE_ROOT = root
  t.after(() => { rmSync(root, { recursive: true, force: true }); delete process.env.WORKSPACE_ROOT })

  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  const app = createApp(db)
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db, root }
}

function makeRun(db, root, runId, tenant) {
  db.prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?, ?, ?, ?, ?)').run(runId, 'done', new Date().toISOString(), tenant, 's_a1')
  mkdirSync(join(root, runId, 'out'), { recursive: true })
  writeFileSync(join(root, runId, 'out', 'report.md'), '# 报告\n内容')
}

test('本租户产物可下载，内容与文件名正确', async (t) => {
  const { base, db, root } = await boot(t)
  makeRun(db, root, 'r1', 't_a')
  const r = await fetch(`${base}/api/artifacts/r1/out/report.md?token=tok_a`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/markdown/)
  assert.match(r.headers.get('content-disposition'), /report\.md/)
  assert.equal(await r.text(), '# 报告\n内容')
})

test('跨租户下载 → 404（不泄露存在性）', async (t) => {
  const { base, db, root } = await boot(t)
  makeRun(db, root, 'r1', 't_a')
  const r = await fetch(`${base}/api/artifacts/r1/out/report.md?token=tok_b`)
  assert.equal(r.status, 404)
})

test('路径穿越 → 400', async (t) => {
  const { base, db, root } = await boot(t)
  makeRun(db, root, 'r1', 't_a')
  writeFileSync(join(root, 'secret.txt'), 'top')
  // 用编码后的 ../ 绕过 URL 归一化，直接命中路由的路径拼接逻辑
  const enc = await fetch(`${base}/api/artifacts/r1/..%2Fsecret.txt?token=tok_a`)
  assert.equal(enc.status, 400, `编码穿越应 400，实际 ${enc.status}`)
  // 未编码的 ../ 会被 URL 归一化掉，落到普通路由（401/404 都算安全）
  const plain = await fetch(`${base}/api/artifacts/r1/../secret.txt?token=tok_a`)
  assert.ok([400, 401, 404].includes(plain.status), `实际 ${plain.status}`)
})

test('无 token → 401；文件不存在 → 404', async (t) => {
  const { base, db, root } = await boot(t)
  makeRun(db, root, 'r1', 't_a')
  assert.equal((await fetch(`${base}/api/artifacts/r1/out/report.md`)).status, 401)
  assert.equal((await fetch(`${base}/api/artifacts/r1/out/nope.md?token=tok_a`)).status, 404)
})
