import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const script = new URL('../../scripts/cf-access-setup.sh', import.meta.url).pathname

function dryRun(env = {}) {
  return spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: 'dummy',
      CF_ACCOUNT_ID: 'acc',
      CF_ZONE_ID: 'zone',
      ALLOW_EMAILS: 'me@example.com',
      HOST: 'cto.ila3.top',
      ...env,
    },
  })
}

test('Cloudflare 接入脚本 dry-run：三份 payload 结构自检通过且不发请求', () => {
  const r = dryRun()
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /结构自检通过/, r.stdout)
  assert.match(r.stdout, /dry-run：未发送任何请求/)
  // 限流必须是 rulesets 形状（顶层 rules 数组），这是接入时最容易写错的地方
  assert.match(r.stdout, /"rules": \[/)
  assert.doesNotMatch(r.stdout, /^  "description": "cube-agent edge rate limit",$/m, '不应再出现平铺的限流规则')
})

test('Cloudflare 接入脚本 dry-run：邮箱列表被正确展开成 include 条件', () => {
  const r = dryRun({ ALLOW_EMAILS: 'a@x.com, b@y.com' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"email": \{"email": "a@x\.com"\}/)
  assert.match(r.stdout, /"email": \{"email": "b@y\.com"\}/)
})
