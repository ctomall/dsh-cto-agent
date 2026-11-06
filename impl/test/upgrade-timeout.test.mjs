import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpgrade, testTimeoutMs } from '../src/upgrade.mjs'

function fakeExec(sha) {
  return async (args) => {
    const cmd = args.join(' ')
    if (cmd.includes('fetch')) return ''
    if (cmd.includes('rev-parse --short HEAD')) return sha
    if (cmd.includes('rev-list --count')) return '1'
    if (cmd.includes('reset')) return ''
    if (cmd.includes('log -1')) return 'abc123 提交'
    return ''
  }
}

test('门禁超时阈值可配（下限 10s，默认 180s）', () => {
  assert.equal(testTimeoutMs({}), 300_000)
  assert.equal(testTimeoutMs({ UPGRADE_TEST_TIMEOUT_MS: '30000' }), 30_000)
  assert.equal(testTimeoutMs({ UPGRADE_TEST_TIMEOUT_MS: '100' }), 300_000, '低于下限应回默认')
  assert.equal(testTimeoutMs({ UPGRADE_TEST_TIMEOUT_MS: 'abc' }), 300_000)
})

test('门禁超时 → 回滚且错误里点名 timeout（不与"测试失败"混为一谈）', async () => {
  let resetCalled = false
  const upgrade = createUpgrade({
    repoDir: '/tmp/fake-repo',
    runTests: true,
    exec: async (args) => {
      if (args.join(' ').includes('reset')) resetCalled = true
      return fakeExec('abc1234')(args)
    },
    runCommand: async () => {
      const e = new Error('killed by timeout')
      e.killed = true
      e.signal = 'SIGTERM'
      throw e
    },
  })
  await assert.rejects(upgrade, (e) => {
    assert.equal(e.code, 'tests_failed_rolled_back')
    assert.match(String(e.message), /timeout|超时/i, `错误里应点名超时：${e.message}`)
    return true
  })
  assert.equal(resetCalled, true, '超时也必须回滚')
})
