import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext, auditDenial, TOKEN_SOURCE } from './context.mjs'
import { createUpgrade, createUpgradeRoute } from './upgrade.mjs'
import { execFileSync } from 'node:child_process'

// 启动时快照：升级后进程若不重启，这个值不会变——正好用来证明"升级到底生效没有"
export const BOOT_SHA = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
})()

// 仓库根 = impl/ 的上一级；升级只作用于本仓库
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const upgradeRoute = createUpgradeRoute({
  token: process.env.CUBE_UPGRADE_TOKEN,
  upgradeOnce: createUpgrade({
    repoDir: REPO_ROOT,
    remote: process.env.UPGRADE_REMOTE ?? 'origin',
    branch: process.env.UPGRADE_BRANCH ?? 'main',
  }),
})

const json = (status, body) => ({ status, body })

// 纯函数式路由：既能被 http server 调用，也能被测试直接调用，避免测试依赖端口。
export function handleRequest(db, req) {
  const url = new URL(req.url, 'http://local')

  // 探活：只暴露启动快照 SHA，不需要身份
  if (req.method === 'GET' && url.pathname === '/api/version') {
    return json(200, { sha: BOOT_SHA })
  }

  const ctx = resolveContext(req.headers?.authorization)
  if (ctx.error) return ctx.error
  const m = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)

  if (req.method === 'GET' && url.pathname === '/api/me') {
    return json(200, { tenantId: ctx.tenantId, userId: ctx.userId })
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const rows = db
      .prepare('select id, title from sessions where tenant_id = ? order by id')
      .all(ctx.tenantId)
    return json(200, { sessions: rows })
  }

  if (req.method === 'GET' && m) {
    const id = decodeURIComponent(m[1])

    // 关键：查询强制带 tenant_id，从根上避免「先查后判」的越权窗口
    const scoped = db
      .prepare('select id, title from sessions where id = ? and tenant_id = ?')
      .get(id, ctx.tenantId)
    if (scoped) return json(200, { session: { id: scoped.id, title: scoped.title } })

    // 未命中：为了审计能还原「哪个租户的哪个资源」，这里额外做一次只读定位（不返回给调用方）
    const owner = db.prepare('select tenant_id from sessions where id = ?').get(id)
    if (owner && owner.tenant_id !== ctx.tenantId) {
      auditDenial(db, ctx, 'cross_tenant_denied', {
        resource: 'session',
        resourceId: id,
        targetTenantId: owner.tenant_id,
      })
      return json(404, { error: 'not_found' })
    }
    return json(404, { error: 'not_found' })
  }

  return json(404, { error: 'not_found' })
}

export function createApp(db) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const isUpgrade = req.method === 'POST' && url.pathname === '/api/admin/upgrade'
    const result = isUpgrade
      ? await upgradeRoute(req)          // 在线一键升级：token 鉴权 + 单飞锁 + 仅 ff-only
      : handleRequest(db, req)
    const { status, body } = result
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))

    // 升级已落盘但进程仍是旧代码：退出由 systemd 拉起，才算真正升级完成
    if (isUpgrade && status === 200 && body?.upToDate === false && process.env.UPGRADE_EXIT_AFTER === '1') {
      res.on('finish', () => setTimeout(() => { console.log('[cube-agent] upgrade applied, exiting for restart'); process.exit(0) }, 200))
    }
  })
}

// 直接运行时监听（测试不经过这里）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { openDb, seedTwoTenants } = await import('./db.mjs')
  const db = openDb()
  seedTwoTenants(db)
  if (TOKEN_SOURCE === 'dev-defaults') {
    console.warn('[cube-agent] WARN: 使用开发默认 token（tok_a/tok_b）。公网部署必须设置 CUBE_TOKENS。')
  }
  const port = Number(process.env.PORT ?? 8787)
  createApp(db).listen(port, () => console.log(`cube-agent gateway on http://127.0.0.1:${port}`))
}
