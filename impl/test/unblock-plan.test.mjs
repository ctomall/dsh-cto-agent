import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const script = new URL('../../scripts/unblock.sh', import.meta.url).pathname
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, TOKEN: '' } })

test('--plan 只打印步骤不执行，且 --base 会改变步骤里的入口', () => {
  const r = run('--model-key', 'sk-dummy', '--plan', '--base', 'https://cto.ila3.top')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /--plan（不执行）/)
  assert.match(r.stdout, /first-real-run\.sh https:\/\/cto\.ila3\.top/, '端到端步骤应使用 --base 指定的入口')
  assert.doesNotMatch(r.stdout, /127\.0\.0\.1:8787\/healthz/, '不应残留硬编码入口')
  // 明确没有执行任何危险动作
  assert.doesNotMatch(r.stdout, /已写入|restarted|升级=/)
})

test('--check 打印当前阻塞项与换入口提示', () => {
  const r = run('--check')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /阻塞项现状/)
  assert.match(r.stdout, /换入口：scripts\/unblock\.sh --check --base/)
})
