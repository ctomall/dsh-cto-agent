import test from 'node:test'
import assert from 'node:assert/strict'

// 一次性探针：故意跑得比门禁阈值久，用来证明"超时与测试失败分得开、且超时也回滚"
test('门禁超时探针（故意慢，不应长期存在）', async () => {
  await new Promise((r) => setTimeout(r, 14_000))
  assert.ok(true)
})
