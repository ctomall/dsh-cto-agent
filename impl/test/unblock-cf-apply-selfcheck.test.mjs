import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// unblock.sh 的 Cloudflare 分支：先验 token，再建 Access 应用 + 边缘限流。
// 这条路径同样只在接 CF token 那天跑——用 mock 端点先把它跑一次。
const script = new URL('../../scripts/unblock.sh', import.meta.url).pathname

function mockCf({ tokenActive = true } = {}) {
  const seen = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url.includes('/user/tokens/verify')) {
        res.end(JSON.stringify({ success: true, result: { status: tokenActive ? 'active' : 'disabled' } }))
      } else if (req.url.endsWith('/access/apps')) {
        res.end(JSON.stringify({ success: true, result: { id: 'app_1' } }))
      } else {
        res.end(JSON.stringify({ success: true, result: {} }))
      }
    })
  })
  return new Promise((r) => srv.listen(0, () => r({ srv, port: srv.address().port, seen })))
}

function run(port, dir) {
  return new Promise((resolve) => {
    const p = spawn('bash', [script, '--cf-token', 'cf-tok', '--cf-account', 'acc', '--cf-zone', 'zone', '--allow-emails', 'me@example.com'], {
      env: {
        PATH: process.env.PATH,
        CF_API_BASE: `http://127.0.0.1:${port}`,
        HOST: 'cto.ila3.top',
        // 关键：绝不碰生产路径，也不跑生产复验（本用例曾经把假 token 写进了 /etc — 已修）
        UNBLOCK_CF_ENV: join(dir, 'cf.env'),
        UNBLOCK_SUDO: '',
        UNBLOCK_SKIP_VERIFY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let s = ''
    p.stdout.on('data', (c) => (s += c))
    p.stderr.on('data', (c) => (s += c))
    p.on('exit', (code) => resolve({ code, s }))
  })
}

test('CF 分支：token 有效 → 依次创建 Access 应用、策略、边缘限流', async (t) => {
  const { srv, port, seen } = await mockCf()
  t.after(() => srv.close())
  const dir = mkdtempSync(join(tmpdir(), 'unblock-cf-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = await run(port, dir)
  // 凭据必须落在临时目录、且 0600
  const cfEnv = join(dir, 'cf.env')
  assert.equal(statSync(cfEnv).mode & 0o777, 0o600, 'cf.env 必须是 0600')
  assert.match(readFileSync(cfEnv, 'utf8'), /CLOUDFLARE_API_TOKEN=cf-tok/)
  assert.equal(r.code, 0, r.s.slice(0, 500))
  assert.match(r.s, /token 有效/)
  const urls = seen.map((x) => x.url).join('\n')
  assert.match(urls, /\/user\/tokens\/verify/)
  assert.match(urls, /\/access\/apps/)
  assert.match(urls, /\/policies/)
  assert.match(urls, /http_ratelimit\/entrypoint/)
})

test('CF 分支：token 无效 → 非零退出且不创建任何东西', async (t) => {
  const { srv, port, seen } = await mockCf({ tokenActive: false })
  t.after(() => srv.close())
  const dir = mkdtempSync(join(tmpdir(), 'unblock-cf2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = await run(port, dir)
  assert.equal(r.code, 4, r.s.slice(0, 300))
  assert.match(r.s, /token 校验未通过/)
  assert.equal(seen.filter((x) => x.url.includes('/access/apps')).length, 0, 'token 无效时不应创建应用')
})
