import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 轻量 fuzz：产物路由与工具沙箱对"路径穿越"载荷必须全部拒绝
const PAYLOADS = [
  '../etc/passwd',
  '../../etc/passwd',
  '..%2f..%2fetc%2fpasswd',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '....//....//etc/passwd',
  'a/../../etc/passwd',
  'a/../../../etc/shadow',
  '/etc/passwd',
  '..\\..\\windows\\win.ini',
  'evil%00.md',
  'x'.repeat(1500) + '/../../etc/passwd',
]

async function boot(t) {
  const root = join(tmpdir(), `cube-fuzz-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(root, 'r_fz'), { recursive: true })
  writeFileSync(join(root, 'r_fz', 'ok.md'), '# ok\n')
  process.env.WORKSPACE_ROOT = root
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_fz', 'done', new Date().toISOString(), 't_a', 's_a1')
  const app = createApp(db)
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }) })
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}

test('产物路由：路径穿越载荷一律 4xx，且不返回系统文件内容', async (t) => {
  const base = await boot(t)
  for (const p of PAYLOADS) {
    const url = `${base}/api/artifacts/r_fz/${p}?inline=1`
    const r = await fetch(url, { headers: { authorization: 'Bearer tok_a' } })
    const body = await r.text().catch(() => '')
    assert.ok(r.status >= 400 && r.status < 500, `${p} 期望 4xx，实际 ${r.status}`)
    assert.ok(!body.includes('root:'), `${p} 泄漏了系统文件内容`)
  }
})

test('合法产物仍可读（fuzz 不能把正常路径也打死）', async (t) => {
  const base = await boot(t)
  const r = await fetch(`${base}/api/artifacts/r_fz/ok.md?inline=1`, { headers: { authorization: 'Bearer tok_a' } })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /# ok/)
})

test('工具沙箱：写入穿越路径 / 符号链接逃逸必须失败', async (t) => {
  const { mkdirSync, rmSync, symlinkSync, readFileSync, existsSync } = await import('node:fs')
  const root = join(tmpdir(), `cube-fuzz-tool-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const outside = join(tmpdir(), `cube-outside-${Date.now()}`)
  mkdirSync(root, { recursive: true }); mkdirSync(outside, { recursive: true })
  process.env.WORKSPACE_ROOT = root
  const { createTools } = await import('../src/tools.mjs')
  const tools = createTools({ workspaceRoot: root })
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

  const cases = ['../evil.txt', '../../evil.txt', '/etc/evil.txt', 'a/../../evil.txt']
  for (const p of cases) {
    await assert.rejects(() => tools.run('fs.write', { path: p, content: 'x' }), undefined, `${p} 应被拒绝`)
    assert.ok(!existsSync(join(outside, 'evil.txt')), `${p} 不得写到工作区外`)
  }

  // 符号链接逃逸：工作区内 link → 外部目录，写入必须失败
  symlinkSync(outside, join(root, 'link'))
  await assert.rejects(() => tools.run('fs.write', { path: 'link/evil.txt', content: 'x' }), undefined, '符号链接应被拒绝')
  assert.ok(!existsSync(join(outside, 'evil.txt')), '不得通过符号链接写到外部')
  assert.equal(readFileSync, readFileSync) // 保持引用，避免 lint 未使用
})
