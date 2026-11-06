import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 拉下来的代码没通过测试 → 必须真的回滚到升级前，不能把坏版本留在磁盘上。
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

test('升级门禁失败时回滚到升级前的提交', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'uprb-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const remote = join(root, 'repo.git')
  git(root, 'init', '--bare', '-b', 'main', remote)

  const work = join(root, 'work')
  git(root, 'clone', remote, work)
  writeFileSync(join(work, 'a.txt'), 'A\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'A')
  git(work, 'push', 'origin', 'main')
  const before = git(work, 'rev-parse', '--short', 'HEAD')

  // 远端再推一个提交（模拟"拉到新代码"）
  const seed = join(root, 'seed')
  git(root, 'clone', remote, seed)
  writeFileSync(join(seed, 'b.txt'), 'B\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'B')
  git(seed, 'push', 'origin', 'main')

  const { createUpgrade } = await import('../src/upgrade.mjs')
  const upgrade = createUpgrade({
    repoDir: work,
    remote: 'origin',
    branch: 'main',
    runTests: true,
    runCommand: () => Promise.reject(new Error('one test failed: boom')), // 模拟门禁失败
  })

  await assert.rejects(upgrade, (e) => {
    assert.equal(e.code, 'tests_failed_rolled_back', `期望 tests_failed_rolled_back，实际 ${e.code}: ${e.message}`)
    assert.match(e.message, new RegExp(before), '错误信息里应写明回滚目标')
    return true
  })

  const after = git(work, 'rev-parse', '--short', 'HEAD')
  assert.equal(after, before, `HEAD 应回滚到 ${before}，实际 ${after}`)
  const status = git(work, 'status', '--porcelain')
  assert.equal(status, '', `回滚后工作区应干净，实际：${status}`)
})
