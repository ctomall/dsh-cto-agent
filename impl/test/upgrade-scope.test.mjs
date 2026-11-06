import test from 'node:test'
import assert from 'node:assert/strict'
import { testFilesForScope } from '../src/upgrade.mjs'

test('升级门禁默认只跑冒烟子集；UPGRADE_TEST_SCOPE=full 时跑全量目录', () => {
  const def = testFilesForScope({})
  assert.ok(Array.isArray(def) && def.length === 5, `默认应为 5 个文件，实际 ${def.length}`)
  assert.ok(def.every((f) => f.endsWith('.test.mjs')))

  const full = testFilesForScope({ UPGRADE_TEST_SCOPE: 'full' })
  assert.deepEqual(full, ['impl/test'], 'full 应指向整个目录')

  // 大小写/空白不影响
  assert.deepEqual(testFilesForScope({ UPGRADE_TEST_SCOPE: ' FULL ' }), ['impl/test'])
})
