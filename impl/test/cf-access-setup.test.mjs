import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// cf-access-setup.sh 是 ③ 的执行器。它最容易出的问题不是"命令写错"，
// 而是**把失败当成功打印**（原实现把 policy / ratelimit 的响应丢进 /dev/null）。
const script = new URL('../../scripts/cf-access-setup.sh', import.meta.url).pathname

function mockCf({ policyOk = true, ratelimitOk = true } = {}) {
  const seen = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body })
      const ok = req.url.includes('/policies') ? policyOk : req.url.includes('/rulesets') ? ratelimitOk : true
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { success: true, result: { id: 'app_1' } } : { success: false, errors: [{ message: 'nope' }] }))
    })
  })
  return new Promise((r) => srv.listen(0, () => r({ srv, port: srv.address().port, seen })))
}

function runSetup(port) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script], {
      env: {
        PATH: process.env.PATH,
        CF_API_BASE: `http://127.0.0.1:${port}`,
        CLOUDFLARE_API_TOKEN: 'tok',
        CF_ACCOUNT_ID: 'acc',
        CF_ZONE_ID: 'zone',
        ALLOW_EMAILS: 'me@example.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('三步都成功 → exit 0，且三个请求都打到了正确路径', async (t) => {
  const { srv, port, seen } = await mockCf()
  t.after(() => srv.close())
  const r = await runSetup(port)
  assert.equal(r.code, 0, r.out)
  assert.equal(seen.length, 3, `应发 3 个请求，实际 ${seen.length}`)
  assert.ok(seen[0].url.includes('/access/apps'), seen[0].url)
  assert.ok(seen[1].url.includes('/policies'), seen[1].url)
  assert.ok(seen[2].url.includes('/rulesets'), seen[2].url)
})

test('策略创建失败 → exit 4 且明说"没有放行规则"', async (t) => {
  const { srv, port } = await mockCf({ policyOk: false })
  t.after(() => srv.close())
  const r = await runSetup(port)
  assert.equal(r.code, 4, r.out)
  assert.match(r.out, /创建 allow 策略失败/)
})

test('限流写入失败 → exit 5 且明说"Access 生效但无限流"', async (t) => {
  const { srv, port } = await mockCf({ ratelimitOk: false })
  t.after(() => srv.close())
  const r = await runSetup(port)
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /写入边缘限流失败/)
})
