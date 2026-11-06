import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// check-cf-edge.sh 的 Cloudflare API 断言**从未跑过**（没有凭据）。它第一次运行会是在接 key 那天，
// 所以先用 mock 端点把它的判断逻辑验一遍：配置正确要全绿，配置缺失要变红。
const script = new URL('../../scripts/check-cf-edge.sh', import.meta.url).pathname

function mockCf({ withApp = true, withRule = true } = {}) {
  const srv = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url.includes('/access/apps') && req.url.endsWith('/access/apps')) {
        res.end(JSON.stringify({ success: true, result: withApp ? [{ id: 'app1', domain: 'cto.ila3.top', name: 'cube' }] : [] }))
      } else if (req.url.includes('/policies')) {
        res.end(JSON.stringify({ success: true, result: [{ id: 'p1', decision: 'allow', include: [{ email: { email: 'me@example.com' } }] }] }))
      } else if (req.url.includes('/rulesets/phases/http_ratelimit/entrypoint')) {
        res.end(JSON.stringify(withRule
          ? { success: true, result: { rules: [{ expression: '(http.host eq "cto.ila3.top")', action: 'block' }] } }
          : { success: true, result: {} }))
      } else {
        res.end(JSON.stringify({ success: true, result: [] }))
      }
    })
  })
  return new Promise((r) => srv.listen(0, () => r({ srv, port: srv.address().port })))
}

function run(port) {
  return new Promise((resolve) => {
    const p = spawn('bash', [script, 'cto.ila3.top'], {
      env: {
        PATH: process.env.PATH,
        CF_API_BASE: `http://127.0.0.1:${port}`,
        CLOUDFLARE_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc', CF_ZONE_ID: 'zone',
        EDGE_ONLY: '0',
        CF_API_ONLY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let s = ''
    p.stdout.on('data', (c) => (s += c))
    p.stderr.on('data', (c) => (s += c))
    p.on('exit', (code) => resolve({ code, s }))
  })
}

test('CF API 段：配置齐全时 Access/策略/限流三项判定为 ok', async (t) => {
  const { srv, port } = await mockCf()
  t.after(() => srv.close())
  const r = await run(port)
  const api = r.s.split('== 3)')[0]
  assert.match(api, /✔ Access 应用存在/, api)
  assert.match(api, /✔ 策略为 allow/, api)
  assert.match(api, /✔ 按邮箱白名单/, api)
  assert.match(api, /✔ 限流规则集/, api)
  assert.match(api, /✔ 限流命中该域名/, api)
})

test('CF API 段：没有 Access 应用 / 没有限流规则时必须变红', async (t) => {
  const { srv, port } = await mockCf({ withApp: false, withRule: false })
  t.after(() => srv.close())
  const r = await run(port)
  const api = r.s.split('== 3)')[0]
  assert.match(api, /✖ Access 应用存在/, api)
  assert.match(api, /✖ 限流规则集/, api)
})
