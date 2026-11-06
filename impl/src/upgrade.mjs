// 在线一键升级：只允许 git fetch / pull --ff-only，不允许 reset --hard 或 clean。
// 安全口径：未配置 token 时接口整体关闭（fail-closed），不是"忘配就裸奔"。
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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

// 测试必须在「干净环境」里跑：服务进程带着 CUBE_TOKENS/APP_PASSWORD/DB_PATH 等，
// 直接继承会让测试连到生产配置（gate 测试期望未开口令门、租户测试期望 dev token），从而必然失败。
const TEST_ENV_STRIP = [
  'CUBE_TOKENS', 'CUBE_UPGRADE_TOKEN', 'APP_PASSWORD', 'APP_SESSION_SECRET',
  'DB_PATH', 'WORKSPACE_ROOT', 'PORT',
  'UPGRADE_RUN_TESTS', 'UPGRADE_EXIT_AFTER', 'UPGRADE_REMOTE', 'UPGRADE_BRANCH',
  'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY', 'MODEL_API_KEY_FILE',
]

export function cleanTestEnv(env = process.env) {
  const out = { ...env }
  for (const k of TEST_ENV_STRIP) delete out[k]
  out.NODE_ENV = 'test'
  return out
}

// 冒烟子集：升级门禁默认只跑这几条（快）。全量用 UPGRADE_TEST_SCOPE=full。
// 注意：子集通过 != 全量通过——曾发生过"子集绿、全量红"的提交被放上生产，见 v135 记录。
const TEST_FILES = [
  'impl/test/tenant-isolation.test.mjs',
  'impl/test/sse-resume.test.mjs',
  'impl/test/upgrade.test.mjs',
  'impl/test/ratelimit.test.mjs',
  'impl/test/gate.test.mjs',
]

// 注意：`node --test impl/test` 在 Node 24 会把目录当成模块去 require 并报错，
// 所以"全量"必须在运行时枚举文件，不能传目录。
export function testFilesForScope(env = process.env, listDir = (dir) => readdirSync(dir), baseDir = process.cwd()) {
  if (String(env.UPGRADE_TEST_SCOPE ?? '').trim().toLowerCase() !== 'full') return TEST_FILES
  try {
    // 必须相对「仓库根」枚举：服务的 cwd 是 <repo>/impl，直接用 process.cwd() 会 ENOENT 并静默回退到冒烟集
    return listDir(join(baseDir, 'impl/test'))
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => `impl/test/${f}`)
  } catch {
    return TEST_FILES // 枚举失败就退回冒烟集，绝不放行一个空列表
  }
}

function defaultExec(repoDir) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: repoDir, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`))
        else resolve(String(stdout).trim())
      })
    })
}

// 门禁失败时从测试输出里抽出"到底哪条挂了"：错误信息里只有文件列表，运维看不出根因。
export function summarizeTestFailure(output, limit = 400) {
  const lines = String(output ?? '').split('\n').map((l) => l.trim())
  const picked = lines.filter((l) => /^✖/.test(l) || /^not ok \d+/.test(l) || /AssertionError/.test(l) || /^ℹ fail [1-9]/.test(l))
  const text = [...new Set(picked)].join(' | ')
  return text ? text.slice(0, limit) : String(output ?? '').trim().slice(0, limit)
}

export function testTimeoutMs(env = process.env) {
  const v = Number(env.UPGRADE_TEST_TIMEOUT_MS)
  return Number.isFinite(v) && v >= 10_000 ? Math.trunc(v) : 180_000
}

export function createUpgrade({ repoDir, remote = 'origin', branch = 'main', runTests = false, exec, runCommand } = {}) {
  const run = exec ?? defaultExec(repoDir)
  const cmd =
    runCommand ??
    ((args) =>
      new Promise((resolve, reject) => {
        const timeout = testTimeoutMs()
        execFile('node', args, { cwd: repoDir, timeout, env: cleanTestEnv() }, (err, stdout, stderr) => {
          if (err) {
            // 超时和"测试真失败"必须区分：前者是门禁自身的边界，后者是代码问题
            const timedOut = err.killed === true || err.signal === 'SIGTERM'
            const raw = `${stdout ?? ''}\n${stderr ?? ''}`.trim() || err.message
            const detail = summarizeTestFailure(raw)
            reject(new Error(timedOut ? `tests_gate_timeout(${timeout}ms): ${detail}` : detail))
            return
          }
          resolve(String(stdout).trim())
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
      let testsMs = null
      if (runTests) {
        const t0 = Date.now()
        try {
          await cmd(['--test', ...testFilesForScope(process.env, undefined, repoDir)])
          tests = 'passed'
          testsMs = Date.now() - t0
        } catch (e) {
          // 拉下来的代码没通过测试：必须回滚，不能把坏版本留在磁盘上
          await run(['reset', '--hard', before]).catch(() => {})
          throw new UpgradeError('tests_failed_rolled_back', `测试失败，已回滚到 ${before}：${e.message}`, 500)
        }
      }

      return { ok: true, upToDate: false, before, after, behind, tests, testsMs, rolledBack: false }
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
