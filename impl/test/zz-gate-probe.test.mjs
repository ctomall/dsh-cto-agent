import test from 'node:test'
import assert from 'node:assert/strict'

// 一次性探针：用来证明"全量门禁"真的会跑到冒烟子集之外的文件
test('门禁探针（故意失败，仅用于验证门禁范围，不应长期存在）', () => {
  assert.fail('gate-probe: 这条失败应当阻止升级')
})
