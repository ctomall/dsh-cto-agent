import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createUpgrade, UpgradeError } from '../src/upgrade.mjs'

// 用真实 git 仓库（裸远端 + 两个 clone）验证升级模块，而不是只靠假 exec
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'upg-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  mkdirSync(seed)
  execFileSync('git', ['init', '--bare', '-q', remote])
  execFileSync('git', ['init', '-q', seed])
  git(seed, 'config', 'user.email', 't@t')
  git(seed, 'config', 'user.name', 't')
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'c1')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, work])
  git(work, 'config', 'user.email', 't@t')
  git(work, 'config', 'user.name', 't')
  return { root, remote, seed, work }
}

test('真实 git：落后一个提交 → ff-only 升级成功', async (t) => {
  const { root, seed, work } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(seed, 'a.txt'), 'two\n')
  git(seed, 'commit', '-qam', 'c2')
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')

  const up = createUpgrade({ repoDir: work, remote: 'origin', branch: 'main' })
  const r = await up()
  assert.equal(r.upToDate, false)
  assert.equal(r.behind, 1)
  assert.notEqual(r.after, r.before)
  assert.equal(git(work, 'rev-parse', '--short', 'HEAD'), git(seed, 'rev-parse', '--short', 'HEAD'))
})

test('真实 git：本地已分叉 → not_fast_forward，HEAD 不动', async (t) => {
  const { root, seed, work } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // 远端往前走
  writeFileSync(join(seed, 'a.txt'), 'two\n')
  git(seed, 'commit', '-qam', 'c2')
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  // 本地也提交
  writeFileSync(join(work, 'local.txt'), 'x\n')
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'local')
  const before = git(work, 'rev-parse', '--short', 'HEAD')

  const up = createUpgrade({ repoDir: work, remote: 'origin', branch: 'main' })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'not_fast_forward')
  assert.equal(git(work, 'rev-parse', '--short', 'HEAD'), before, '分叉时 HEAD 必须保持不变')
})

test('真实 git：测试失败 → 回滚到升级前提交', async (t) => {
  const { root, seed, work } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(seed, 'a.txt'), 'two\n')
  git(seed, 'commit', '-qam', 'c2')
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  const before = git(work, 'rev-parse', '--short', 'HEAD')

  const up = createUpgrade({
    repoDir: work, remote: 'origin', branch: 'main', runTests: true,
    runCommand: async () => { throw new Error('tests failed') },
  })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'tests_failed_rolled_back')
  assert.equal(git(work, 'rev-parse', '--short', 'HEAD'), before, '测试失败必须回滚')
  assert.equal(git(work, 'status', '--porcelain'), '', '工作区不应残留改动')
})
