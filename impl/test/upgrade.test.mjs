import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpgrade, createUpgradeRoute, UpgradeError } from '../src/upgrade.mjs'

// 用可注入的假 git，断言"发的是哪条命令、错了怎么返回"，避免测试依赖真实远程
function fakeExec(handlers) {
  const calls = []
  const fn = async (args) => {
    calls.push(args.join(' '))
    const h = handlers[args[0]]
    if (!h) return ''
    return typeof h === 'function' ? h(args) : h
  }
  fn.calls = calls
  return fn
}

test('未配置 token → 503 关闭（fail-closed）', async () => {
  const route = createUpgradeRoute({ token: undefined, upgradeOnce: async () => ({}) })
  const r = await route({ headers: {} })
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'upgrade_disabled')
})

test('token 错误 / 缺失 → 401', async () => {
  const route = createUpgradeRoute({ token: 'secret', upgradeOnce: async () => ({}) })
  assert.equal((await route({ headers: {} })).status, 401)
  assert.equal((await route({ headers: { 'x-upgrade-token': 'wrong' } })).status, 401)
})

test('正常升级：返回 before/after/behind', async () => {
  const route = createUpgradeRoute({ token: 'secret', upgradeOnce: async () => ({ ok: true, before: 'aaa', after: 'bbb', behind: 2 }) })
  const r = await route({ headers: { 'x-upgrade-token': 'secret' } })
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.before, r.body.after, r.body.behind], ['aaa', 'bbb', 2])
})

test('脏工作区 → 409，且不执行 fetch/pull', async () => {
  const exec = fakeExec({ 'rev-parse': 'true', status: ' M README.md\n' })
  const up = createUpgrade({ repoDir: '/repo', exec })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'dirty_worktree')
  assert.equal(exec.calls.some((c) => c.startsWith('fetch')), false)
  assert.equal(exec.calls.some((c) => c.startsWith('pull')), false)
})

test('已是最新：不执行 pull', async () => {
  const exec = fakeExec({
    'rev-parse': (args) => (args.includes('--short') ? 'aaa' : 'true'),
    status: '',
    fetch: '',
    'rev-list': '0',
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  const r = await up()
  assert.equal(r.upToDate, true)
  assert.equal(r.before, 'aaa')
  assert.equal(exec.calls.some((c) => c.startsWith('pull')), false)
})

test('落后 N 个提交：ff-only 拉取并返回新 SHA', async () => {
  let shortCalls = 0
  const exec = fakeExec({
    'rev-parse': (args) => {
      if (args.includes('--short')) return ['aaa', 'bbb'][Math.min(shortCalls++, 1)]
      return 'true'
    },
    status: '',
    fetch: '',
    'rev-list': '3',
    pull: '',
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  const r = await up()
  assert.equal(r.upToDate, false)
  assert.equal(r.behind, 3)
  assert.deepEqual([r.before, r.after], ['aaa', 'bbb'])
  assert.ok(exec.calls.includes('pull --ff-only origin main'))
})

test('并发调用 → 第二次 409（单飞锁）', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const exec = async (args) => {
    if (args[0] === 'rev-parse' && !args.includes('--short')) return 'true'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return 'aaa'
    if (args[0] === 'fetch') { await gate; return '' }
    return ''
  }
  const up = createUpgrade({ repoDir: '/repo', exec })
  const first = up()
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'upgrade_in_progress')
  release()
  await first
})

test('fetch 失败 → 502，不冒成 500', async () => {
  const exec = fakeExec({
    'rev-parse': (args) => (args.includes('--short') ? 'aaa' : 'true'),
    status: '',
    fetch: () => { throw new Error('remote unreachable') },
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.status === 502)
})
