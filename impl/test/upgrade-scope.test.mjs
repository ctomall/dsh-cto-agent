import test from 'node:test'
import assert from 'node:assert/strict'
import { testFilesForScope } from '../src/upgrade.mjs'

const TEST_REF = testFilesForScope({})

test('升级门禁默认只跑冒烟子集；UPGRADE_TEST_SCOPE=full 时跑全量目录', () => {
  const def = testFilesForScope({})
  assert.ok(Array.isArray(def) && def.length === 5, `默认应为 5 个文件，实际 ${def.length}`)
  assert.ok(def.every((f) => f.endsWith('.test.mjs')))

  const seen = []
  const fakeDir = (dir) => { seen.push(dir); return ['a.test.mjs', 'b.test.mjs', 'helper.mjs', 'c.test.mjs'] }
  const full = testFilesForScope({ UPGRADE_TEST_SCOPE: 'full' }, fakeDir, '/opt/cube-agent')
  assert.equal(seen[0], '/opt/cube-agent/impl/test', '必须按仓库根拼路径（服务 cwd 是 <repo>/impl）')
  assert.deepEqual(full, ['impl/test/a.test.mjs', 'impl/test/b.test.mjs', 'impl/test/c.test.mjs'], '应枚举全部 *.test.mjs 且排序')
  assert.ok(!full.includes('impl/test'), '绝不能把目录当测试文件传进去（Node 24 会报 MODULE_NOT_FOUND）')

  // 大小写/空白不影响
  assert.deepEqual(testFilesForScope({ UPGRADE_TEST_SCOPE: ' FULL ' }, fakeDir), full)

  // 枚举失败要退回冒烟集，绝不放行空列表
  const boom = () => { throw new Error('nope') }
  assert.deepEqual(testFilesForScope({ UPGRADE_TEST_SCOPE: 'full' }, boom), TEST_REF, '枚举失败应回退')
})
