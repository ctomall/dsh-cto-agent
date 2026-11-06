// 在线一键升级：只允许 git fetch / pull --ff-only，不允许 reset --hard 或 clean。
// 安全口径：未配置 token 时接口整体关闭（fail-closed），不是"忘配就裸奔"。
import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'

// 常量时间比较：避免通过响应时间侧信道推断 token
const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(String(a ?? '')).digest()
  const hb = createHash('sha256').update(String(b ?? '')).digest()
  return timingSafeEqual(ha, hb)
}

export class UpgradeError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

const TEST_FILES = [
  'impl/test/tenant-isolation.test.mjs',
  'impl/test/sse-resume.test.mjs',
  'impl/test/upgrade.test.mjs',
  'impl/test/ratelimit.test.mjs',
  'impl/test/gate.test.mjs',
]

function defaultExec(repoDir) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: repoDir, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`))
        else resolve(String(stdout).trim())
      })
    })
}

export function createUpgrade({ repoDir, remote = 'origin', branch = 'main', runTests = false, exec, runCommand } = {}) {
  const run = exec ?? defaultExec(repoDir)
  const cmd =
    runCommand ??
    ((args) =>
      new Promise((resolve, reject) => {
        execFile('node', args, { cwd: repoDir, timeout: 180_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`${(stderr || err.message).trim()}`.slice(0, 400)))
          else resolve(String(stdout).trim())
        })
      }))
  let inFlight = false

  return async function upgradeOnce() {
    if (inFlight) throw new UpgradeError('upgrade_in_progress', 'another upgrade is running', 409)
    inFlight = true
    try {
      await run(['rev-parse', '--is-inside-work-tree']).catch(() => {
        throw new UpgradeError('not_a_git_repo', `${repoDir} is not a git repository`, 500)
      })

      const dirty = await run(['status', '--porcelain'])
      if (dirty) throw new UpgradeError('dirty_worktree', 'working tree has local changes; commit or stash first', 409)

      const before = await run(['rev-parse', '--short', 'HEAD'])
      await run(['fetch', '--prune', remote, branch]).catch((e) => {
        throw new UpgradeError('fetch_failed', e.message, 502)
      })
      const behind = Number(await run(['rev-list', '--count', `HEAD..${remote}/${branch}`]))

      if (behind === 0) {
        return { ok: true, upToDate: true, before, after: before, behind: 0, tests: 'skipped' }
      }

      // 先证明能快进：HEAD 必须是 origin/main 的祖先，否则一律拒绝（不尝试 pull、不 reset）
      const canFastForward = await run(['merge-base', '--is-ancestor', 'HEAD', `${remote}/${branch}`])
        .then(() => true)
        .catch(() => false)
      if (!canFastForward) {
        throw new UpgradeError('not_fast_forward', `本地与 ${remote}/${branch} 已分叉，拒绝非快进合并`, 409)
      }

      await run(['pull', '--ff-only', remote, branch]).catch((e) => {
        throw new UpgradeError('pull_failed', e.message, 500)
      })
      let after = await run(['rev-parse', '--short', 'HEAD'])

      let tests = 'skipped'
      if (runTests) {
        try {
          await cmd(['--test', ...TEST_FILES])
          tests = 'passed'
        } catch (e) {
          // 拉下来的代码没通过测试：必须回滚，不能把坏版本留在磁盘上
          await run(['reset', '--hard', before]).catch(() => {})
          throw new UpgradeError('tests_failed_rolled_back', `测试失败，已回滚到 ${before}：${e.message}`, 500)
        }
      }

      return { ok: true, upToDate: false, before, after, behind, tests, rolledBack: false }
    } finally {
      inFlight = false
    }
  }
}

export function createUpgradeRoute({ token, upgradeOnce }) {
  return async function handleUpgrade(req) {
    if (!token) {
      return { status: 503, body: { error: 'upgrade_disabled', detail: 'CUBE_UPGRADE_TOKEN is not configured' } }
    }
    const got = req.headers?.['x-upgrade-token']
    if (!got || !safeEqual(got, token)) {
      return { status: 401, body: { error: 'unauthenticated' } }
    }
    try {
      const result = await upgradeOnce()
      return { status: 200, body: result }
    } catch (e) {
      if (e instanceof UpgradeError) return { status: e.status, body: { error: e.code, detail: e.message } }
      return { status: 500, body: { error: 'internal_error', detail: String(e?.message ?? e) } }
    }
  }
}
