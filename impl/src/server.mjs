import { createServer } from 'node:http'
import { dirname, resolve, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolveContext, auditDenial, TOKEN_SOURCE } from './context.mjs'
import { createUpgrade, createUpgradeRoute } from './upgrade.mjs'
import { execFileSync } from 'node:child_process'
import { EventLog } from './events.mjs'
import { RunController } from './runs.mjs'
import { handleLiveEvents, parseLastEventId } from './sse.mjs'

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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const upgradeRoute = createUpgradeRoute({
  token: process.env.CUBE_UPGRADE_TOKEN,
  upgradeOnce: createUpgrade({
    repoDir: REPO_ROOT,
    remote: process.env.UPGRADE_REMOTE ?? 'origin',
    branch: process.env.UPGRADE_BRANCH ?? 'main',
  }),
})

const json = (status, body) => ({ status, body })

const readJson = (req) =>
  new Promise((res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try { res(raw ? JSON.parse(raw) : {}) } catch { res({}) }
    })
  })

// 纯函数式路由（同步部分）：测试可直接调用，不需要端口
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

export function createApp(db, { log = new EventLog(db), rc = new RunController(db, log) } = {}) {
  let seq = 0
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')

    // —— 静态前端 ——
    if (req.method === 'GET' && (url.pathname === '/' || /^\/(app\.(js|css)|favicon\.svg)$/.test(url.pathname))) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      try {
        const buf = await readFile(resolve(WEB_ROOT, file))
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' })
        return res.end('not found')
      }
    }

    // —— SSE：回放 + 实时推送（EventSource 不能带 header，故允许 ?token=）——
    const evm = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname)
    if (req.method === 'GET' && evm) {
      const auth = req.headers?.authorization ?? `Bearer ${url.searchParams.get('token') ?? ''}`
      const ctx = resolveContext(auth)
      if (ctx.error) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthenticated"}') }
      const runId = decodeURIComponent(evm[1])
      if (!rc.status(runId)) { res.writeHead(404); return res.end() }
      return handleLiveEvents({ req, res, log, rc, runId, lastEventId: parseLastEventId(req.headers['last-event-id'], url.searchParams.get('lastEventId')) })
    }

    // —— 创建 run（跑到审批处停下）——
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const ctx = resolveContext(req.headers?.authorization)
      if (ctx.error) return reply(res, ctx)
      const body = await readJson(req)
      const runId = `r${Date.now()}${(seq++).toString(36)}`
      rc.startToApproval(runId, { input: String(body.input ?? '') })
      return reply(res, json(202, { runId }))
    }

    // —— 审批回写 ——
    const ap = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && ap) {
      const ctx = resolveContext(req.headers?.authorization)
      if (ctx.error) return reply(res, ctx)
      const runId = decodeURIComponent(ap[1])
      if (!rc.status(runId)) return reply(res, json(404, { error: 'not_found' }))
      const body = await readJson(req)
      const decision = body.decision === 'deny' ? 'deny' : 'allow_once'
      return reply(res, json(200, rc.decideApproval(runId, decision)))
    }

    // —— 升级 ——
    if (req.method === 'POST' && url.pathname === '/api/admin/upgrade') {
      const result = await upgradeRoute(req)
      reply(res, result)
      if (result.status === 200 && result.body?.upToDate === false && process.env.UPGRADE_EXIT_AFTER === '1') {
        res.on('finish', () => setTimeout(() => { console.log('[cube-agent] upgrade applied, exiting for restart'); process.exit(0) }, 200))
      }
      return
    }

    reply(res, handleRequest(db, req))
  })
}

function reply(res, { status, body }) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
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
