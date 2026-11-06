import test from 'node:test'
import assert from 'node:assert/strict'

// 门禁失败时，错误信息必须能指出"哪条用例挂了"，而不是只给一串文件路径。
test('summarizeTestFailure 抽出失败用例与计数', async () => {
  const { summarizeTestFailure } = await import('../src/upgrade.mjs')
  const output = [
    'imp:  impl/test/a.test.mjs',
    '✖ 会话级授权：第二个run不该再弹卡 (12ms)',
    '  AssertionError: 期望 0，实际 1',
    'ℹ fail 1',
  ].join('\n')
  const s = summarizeTestFailure(output)
  assert.match(s, /✖ 会话级授权/, s)
  assert.match(s, /fail 1/, s)
  assert.ok(!s.includes('impl/test/a.test.mjs'), '不应只剩文件路径')
})

test('summarizeTestFailure 对空输出安全', async () => {
  const { summarizeTestFailure } = await import('../src/upgrade.mjs')
  assert.equal(summarizeTestFailure(''), '')
  assert.ok(summarizeTestFailure(null).length === 0)
})
