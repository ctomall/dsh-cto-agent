import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function boot(t) {
  const root = join(tmpdir(), `cube-art-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  process.env.WORKSPACE_ROOT = root
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_art', 'done', new Date().toISOString(), 't_a', 's_a1')
  const dir = join(root, 'r_art'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'note.md'), '# 标题\n')
  writeFileSync(join(dir, 'evil.html'), '<script>alert(1)</script>')
  writeFileSync(join(dir, 'evil.svg'), '<svg onload="alert(1)"></svg>')
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const app = createApp(db)
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }) })
  await new Promise((r) => app.listen(0, r))
  return `http://127.0.0.1:${app.address().port}`
}
const H = { authorization: 'Bearer tok_a' }

test('预览只内联安全类型；html/svg 永远强制下载', async (t) => {
  const base = await boot(t)
  const get = (p) => fetch(`${base}${p}`, { headers: H })

  const md = await get('/api/artifacts/r_art/note.md?inline=1')
  assert.equal(md.status, 200)
  assert.match(String(md.headers.get('content-disposition')), /^inline/, 'markdown 可内联预览')
  assert.match(String(md.headers.get('content-type')), /text\/markdown; charset=utf-8/)

  for (const f of ['evil.html', 'evil.svg']) {
    const r = await get(`/api/artifacts/r_art/${f}?inline=1`)
    assert.equal(r.status, 200)
    assert.match(String(r.headers.get('content-disposition')), /^attachment/, `${f} 必须下载而不是渲染`)
  }

  const png = await get('/api/artifacts/r_art/pic.png?inline=1')
  assert.match(String(png.headers.get('content-disposition')), /^inline/, '图片可内联')

  const noFlag = await get('/api/artifacts/r_art/note.md')
  assert.match(String(noFlag.headers.get('content-disposition')), /^attachment/, '不带 inline 参数一律下载')
})

test('属性测试：MIME 表里任何"可执行/可带脚本"的类型都不允许内联', async () => {
  const { MIME, INLINE_OK } = await import('../src/server.mjs')
  const dangerous = /^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml|application\/mhtml|multipart\/related|text\/javascript|application\/javascript)/
  for (const [ext, mime] of Object.entries(MIME)) {
    const base = String(mime).split(';')[0].trim().toLowerCase()
    if (dangerous.test(base)) {
      assert.ok(!INLINE_OK.has(base), `${ext}(${base}) 不允许出现在内联白名单里`)
    }
  }
  // 白名单自身也不许混入危险类型
  for (const t of INLINE_OK) assert.ok(!dangerous.test(t), `白名单混入了危险类型：${t}`)
})

test('属性测试：MIME 表里的每个扩展名，内联与否严格等于白名单判定（无例外）', async (t) => {
  const { MIME, INLINE_OK } = await import('../src/server.mjs')
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const root = join(tmpdir(), `cube-mime-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  process.env.WORKSPACE_ROOT = root
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_mime', 'done', new Date().toISOString(), 't_a', 's_a1')
  const dir = join(root, 'r_mime'); mkdirSync(dir, { recursive: true })
  for (const ext of Object.keys(MIME)) writeFileSync(join(dir, `f${ext}`), 'x')
  const app = createApp(db)
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }) })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`

  for (const [ext, mime] of Object.entries(MIME)) {
    const raw = String(mime).split(';')[0].trim().toLowerCase()
    const want = INLINE_OK.has(raw)
    const r = await fetch(`${base}/api/artifacts/r_mime/f${ext}?inline=1`, { headers: { authorization: 'Bearer tok_a' } })
    assert.equal(r.status, 200, `${ext} 应可读取`)
    const disp = String(r.headers.get('content-disposition') ?? '')
    assert.equal(disp.startsWith('inline'), want, `${ext}(${raw}) 期望 ${want ? 'inline' : 'attachment'}，实际: ${disp}`)
  }
})

test('未知扩展名一律 attachment（即便带 inline=1）', async (t) => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = join(tmpdir(), `cube-unk-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(root, 'r_unk'), { recursive: true })
  process.env.WORKSPACE_ROOT = root
  for (const f of ['a.zip', 'b.bin', 'c.unknownext']) writeFileSync(join(root, 'r_unk', f), 'x')
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const db = openDb(); seedTwoTenants(db)
  db.prepare('insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)')
    .run('r_unk', 'done', new Date().toISOString(), 't_a', 's_a1')
  const app = createApp(db)
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }) })
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  for (const f of ['a.zip', 'b.bin', 'c.unknownext']) {
    const r = await fetch(`${base}/api/artifacts/r_unk/${f}?inline=1`, { headers: { authorization: 'Bearer tok_a' } })
    assert.equal(r.status, 200)
    assert.match(String(r.headers.get('content-disposition')), /^attachment/, `${f} 必须 attachment`)
    assert.match(String(r.headers.get('content-type')), /application\/octet-stream/, `${f} 应为 octet-stream`)
  }
})
