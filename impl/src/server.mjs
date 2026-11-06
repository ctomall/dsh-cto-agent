import { createServer } from 'node:http'
import { dirname, resolve, extname, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolveContext, auditDenial, TOKEN_SOURCE, UNAUTHENTICATED } from './context.mjs'
import { createUpgrade, createUpgradeRoute } from './upgrade.mjs'
import { execFileSync } from 'node:child_process'
import { EventLog } from './events.mjs'
import { RunController } from './runs.mjs'
import { handleLiveEvents, handleEventsRequest, parseLastEventId } from './sse.mjs'
import { AgentLoop } from './loop.mjs'
import { createTools } from './tools.mjs'
import { createDriverFromEnv } from './model.mjs'
import { createGrants } from './grants.mjs'
import { createRateLimiter, LIMITS, bucketFor, clientIp } from './ratelimit.mjs'
import { createGate, LOGIN_HTML } from './gate.mjs'
import { createMetrics } from './metrics.mjs'

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
    runTests: process.env.UPGRADE_RUN_TESTS === '1',
  }),
})

const json = (status, body) => ({ status, body })

const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 1_048_576) // 1 MiB
class BodyTooLarge extends Error {}

function collect(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY) { req.destroy(); resolve(''); return }
      raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const readForm = (req) =>
  collect(req).then((raw) => Object.fromEntries(new URLSearchParams(raw)))

const readJson = (req) =>
  collect(req).then((raw) => {
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  })

// 纯函数式路由（同步部分）：测试可直接调用，不需要端口
// resolveCtx 由调用方注入：createApp 传入带 Cookie 映射的版本；测试可直接调用（默认只认 Bearer）
export function handleRequest(db, req, resolveCtx = (r) => resolveContext(r.headers?.authorization)) {
  const url = new URL(req.url, 'http://local')
  const ctxOf = resolveCtx

  // 探活：只暴露启动快照 SHA，不需要身份
  if (req.method === 'GET' && url.pathname === '/api/version') {
    return json(200, { sha: BOOT_SHA })
  }

  const ctx = ctxOf(req)
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
}

export function createApp(db, { log = new EventLog(db), rc = new RunController(db, log) } = {}) {
  let seq = 0
  const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/tmp/cube-agent-workspace'
  const { driver, source: driverSource } = createDriverFromEnv()
  const limiter = createRateLimiter()
  const metrics = createMetrics()
  // 0 值也要出现在 /metrics 里，否则"没数据"和"没这个指标"分不清
  metrics.inc('runs_created_total', { driver: 'fake' }, 0)
  metrics.inc('runs_created_total', { driver: 'real' }, 0)
  for (const d of ['allow_once', 'allow_session', 'deny']) metrics.inc('approvals_total', { decision: d }, 0)
  for (const b of ['api', 'runs', 'upgrade', 'login']) metrics.inc('rate_limited_total', { bucket: b }, 0)
  metrics.inc('login_failures_total', {}, 0)
  metrics.inc('grants_revoked_total', {}, 0)
  const gate = createGate({ password: process.env.APP_PASSWORD, secret: process.env.APP_SESSION_SECRET })
  // Cookie 身份门只证明"过了口令"，不区分租户；API 身份统一在这里解析：
  //   1) 有 Bearer → 按 token 解析（多租户正路）
  //   2) 无 Bearer 但 Cookie 有效 → 映射到 GATE_TENANT/GATE_USER（单口令部署的兜底）
  const GATE_TENANT = process.env.GATE_TENANT ?? 't_a'
  const GATE_USER = process.env.GATE_USER ?? 'u_a'
  const cookieAuthed = (req) => !req.headers?.authorization && !!gate && gate.verify(req.headers?.cookie)
  const ctxOf = (req) => {
    const auth = req.headers?.authorization
    if (auth) return resolveContext(auth)
    if (cookieAuthed(req)) return { tenantId: GATE_TENANT, userId: GATE_USER, permissions: [] }
    return { error: UNAUTHENTICATED }
  }
  if (gate) console.log('[cube-agent] 身份门：已开启（APP_PASSWORD）')
  const grants = createGrants(db)
  const loop = new AgentLoop({
    rc,
    tools: createTools({ workspaceRoot: WORKSPACE_ROOT }),
    driver,
    grants,
    workspaceRoot: WORKSPACE_ROOT,
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 120_000),
    loadHistory: ({ tenantId, sessionId, limit }) =>
      db
        .prepare('select role, content from messages where tenant_id = ? and session_id = ? order by rowid desc limit ?')
        .all(tenantId, sessionId, Number(limit))
        .reverse()
        .map((r) => ({ role: r.role, content: r.content })),
    toolResults: {
      get: (runId, callId) => {
        const r = db.prepare('select * from run_tool_results where run_id = ? and call_id = ?').get(runId, callId)
        if (!r) return null
        return { ok: r.ok, content: r.content, error: r.error }
      },
      put: ({ runId, callId, ok, content, artifact, error }) =>
        db
          .prepare(
            'insert or replace into run_tool_results (run_id, call_id, ok, content, artifact_json, error, created_at) values (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(runId, callId, ok, content, artifact ? JSON.stringify(artifact) : null, error, new Date().toISOString()),
    },
    pendingStore: {
      save: ({ runId, tenantId, sessionId, messages, call, callId, steps }) =>
        db
          .prepare(
            'insert or replace into run_pending (run_id, tenant_id, session_id, messages_json, call_json, call_id, steps, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(runId, tenantId, sessionId, JSON.stringify(messages), JSON.stringify(call), callId, steps ?? 0, new Date().toISOString()),
      load: (runId) => {
        const r = db.prepare('select * from run_pending where run_id = ?').get(runId)
        if (!r) return null
        try {
          return {
            messages: JSON.parse(r.messages_json),
            call: JSON.parse(r.call_json),
            callId: r.call_id,
            steps: r.steps,
            tenantId: r.tenant_id,
            sessionId: r.session_id,
          }
        } catch {
          return null
        }
      },
      clear: (runId) => db.prepare('delete from run_pending where run_id = ?').run(runId),
    },
    store: ({ tenantId, sessionId, runId, role, content }) =>
      db
        .prepare('insert into messages (id, tenant_id, session_id, role, content, created_at) values (?, ?, ?, ?, ?, ?)')
        .run(`${runId}-${role}-${Math.random().toString(16).slice(2, 8)}`, tenantId, sessionId, role, content, new Date().toISOString()),
    audit: ({ tenantId, sessionId, tool, decision }) =>
      db
        .prepare('insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)')
        .run(tenantId, 'system', 'approval_auto_approved', JSON.stringify({ tool, sessionId, decision }), new Date().toISOString()),
  })
  console.log(`[cube-agent] model driver: ${driver.name} (${driverSource})`)
  // —— 保留策略：工具结果缓存会随运行增长，按 RETENTION_DAYS（默认 30）清理 ——
  const keepDays = Number(process.env.RETENTION_DAYS ?? 30)
  if (Number.isFinite(keepDays) && keepDays > 0) {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
    const info = db.prepare('delete from run_tool_results where created_at < ?').run(cutoff)
    if (Number(info.changes ?? 0) > 0) console.log(`[cube-agent] 清理过期工具结果 ${info.changes} 条（>${keepDays}d）`)
  }

  // —— 启动收敛：上个进程遗留的 running / waiting_approval 已无内存态可恢复 ——
  // 不收敛的话：页面会出现"点不动的待审批"（僵尸项），审批接口只会回 no_pending_approval。
  const resumable = new Set(db.prepare('select run_id from run_pending').all().map((r) => r.run_id))
  for (const o of db.prepare("select id, tenant_id from runs where status in ('running', 'waiting_approval')").all()) {
    if (resumable.has(o.id)) continue // 有落库的审批快照 → 重启后仍可继续
    const ts = new Date().toISOString()
    db.prepare('update runs set status = ?, ended_at = ? where id = ?').run('failed', ts, o.id)
    log.append(o.id, 'run.failed', { runId: o.id, error: 'interrupted_by_restart' })
    db.prepare('insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)')
      .run(o.tenant_id ?? 't_a', 'system', 'run_interrupted', JSON.stringify({ runId: o.id }), ts)
  }

  // 审批界面的安全响应头：防点击劫持 + 严格 CSP（页面无内联脚本/样式）
  const SEC_HEADERS = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  }
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const origWriteHead = res.writeHead.bind(res)
    res.writeHead = (status, headers) => {
      if (Array.isArray(headers)) return origWriteHead(status, [...headers, ...Object.entries(SEC_HEADERS)])
      return origWriteHead(status, { ...(headers ?? {}), ...SEC_HEADERS })
    }

    // —— 请求体上限：先看 content-length，避免把大包读进内存 ——
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      return reply(res, json(413, { error: 'payload_too_large', limit: MAX_BODY }))
    }

    // —— 限流：先于一切业务逻辑，避免打穿到数据库/模型 ——
    const bucket = bucketFor(url.pathname, req.method)
    if (bucket) {
      const { limit, windowMs } = LIMITS[bucket]
      const r = limiter.check(`${clientIp(req)}:${bucket}`, limit, windowMs)
      if (!r.ok) {
        metrics.inc('rate_limited_total', { bucket })
        res.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(r.retryAfter),
          'cache-control': 'no-store',
        })
        return res.end(JSON.stringify({ error: 'rate_limited', bucket, limit: r.limit, retryAfter: r.retryAfter }))
      }
      res.setHeader('x-ratelimit-remaining', String(r.remaining))
    }

    // —— 身份门（Cloudflare Access 未配置时的兜底；未配 APP_PASSWORD 时整体关闭）——
    if (gate) {
      const open = url.pathname === '/login' || url.pathname === '/api/version' || url.pathname === '/healthz'
      if (!open && !gate.verify(req.headers.cookie)) {
        if (url.pathname.startsWith('/api/')) return reply(res, json(401, { error: 'unauthenticated' }))
        res.writeHead(302, { location: '/login', 'cache-control': 'no-store' })
        return res.end()
      }
    }

    // —— CSRF：Cookie 身份 + 变更请求时，要求同源（浏览器会给 sec-fetch-site）——
    if (cookieAuthed(req) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const site = req.headers['sec-fetch-site']
      if (site && site !== 'same-origin') return reply(res, json(403, { error: 'csrf_blocked' }))
    }

    // —— 登录页与提交 ——
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(LOGIN_HTML.replace('<!--ERR-->', ''))
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const form = await readForm(req)
      if (gate && !gate.checkPassword(form.password)) metrics.inc('login_failures_total')
      if (gate && gate.checkPassword(form.password)) {
        const https = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase().includes('https') ||
          process.env.COOKIE_SECURE === '1'
        res.writeHead(302, { location: '/', 'set-cookie': gate.cookie({ secure: https }), 'cache-control': 'no-store' })
        return res.end()
      }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(LOGIN_HTML.replace('<!--ERR-->', '<p class="err">口令不正确</p>'))
    }

    // —— 产物下载/预览：租户校验 + 工作区路径约束（浏览器 <a> 带不了 header，故允许 ?token=）——
    const art = /^\/api\/artifacts\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (req.method === 'GET' && art) {
      const bearer = req.headers.authorization ?? `Bearer ${url.searchParams.get('token') ?? ''}`
      const ctx = resolveContext(bearer)
      if (ctx.error) return reply(res, ctx.error)

      const runId = decodeURIComponent(art[1])
      const rel = decodeURIComponent(art[2])
      const run = db.prepare('select tenant_id from runs where id = ?').get(runId)
      if (!run || run.tenant_id !== ctx.tenantId) return reply(res, json(404, { error: 'not_found' }))

      const root = resolve(WORKSPACE_ROOT, runId)
      const abs = resolve(root, rel)
      if (abs !== root && !abs.startsWith(root + sep)) return reply(res, json(400, { error: 'path_outside_workspace' }))
      try {
        const buf = await readFile(abs)
        const type = MIME[extname(abs)] ?? 'application/octet-stream'
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(buf.length),
          'content-disposition': `attachment; filename="${abs.split('/').pop()}"`,
          'cache-control': 'no-store',
        })
        return res.end(buf)
      } catch {
        return reply(res, json(404, { error: 'not_found' }))
      }
    }

    // —— 指标（与页面同门禁，避免公网裸看流量）——
    if (req.method === 'GET' && url.pathname === '/metrics') {
      metrics.set('model_real', {}, driver.name.startsWith('fake') ? 0 : 1)
      metrics.set('session_grants', {}, Number(db.prepare('select count(*) c from session_grants').get().c))
      try {
        metrics.set('db_events_rows', {}, Number(db.prepare('select count(*) c from events').get().c))
        metrics.set('db_size_bytes', {}, Number(db.prepare('pragma page_count').get().page_count) * Number(db.prepare('pragma page_size').get().page_size))
      } catch {}
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(metrics.render())
    }

    // —— 模型状态（① 的可观测性：一眼看出线上是真模型还是假模型）——
    if (req.method === 'GET' && url.pathname === '/api/model/status') {
      if (gate && !gate.verify(req.headers.cookie)) return reply(res, json(401, { error: 'unauthenticated' }))
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      return reply(res, json(200, { driver: driver.name, source: driverSource, real: !driver.name.startsWith('fake') }))
    }

    // —— 探活 ——
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return reply(res, json(200, { ok: true, driver: driver.name }))
    }

    // —— 会话内活动 run：刷新/新开标签页后仍能接上进行中的执行 ——
    const ar = /^\/api\/sessions\/([^/]+)\/active$/.exec(url.pathname)
    if (req.method === 'GET' && ar) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(ar[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const rows = db
        .prepare("select id, status from runs where tenant_id = ? and session_id = ? and status in ('running','waiting_approval') order by started_at")
        .all(ctx.tenantId, sessionId)
      const active = rows.map((r) => ({
        runId: r.id,
        status: r.status,
        lastSeq: Number(db.prepare('select coalesce(max(seq), 0) s from events where run_id = ?').get(r.id).s),
      }))
      return reply(res, json(200, { active }))
    }

    // —— 会话产物列表：刷新后产物不能凭空消失（文件还在磁盘上）——
    const al = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(url.pathname)
    if (req.method === 'GET' && al) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(al[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const runs = db
        .prepare('select id from runs where tenant_id = ? and session_id = ? order by started_at')
        .all(ctx.tenantId, sessionId)
      const items = []
      for (const r of runs) {
        for (const ev of db
          .prepare("select payload_json from events where run_id = ? and type = 'artifact.created' order by seq")
          .all(r.id)) {
          try {
            const p = JSON.parse(ev.payload_json)
            items.push({ runId: r.id, path: p.path, mime: p.mime ?? null, size: p.size ?? null })
          } catch {}
        }
      }
      // 同名产物多次生成时只留最新一份，避免面板里一排 report.md
      const byPath = new Map()
      for (const it of items) byPath.set(it.path, it)
      return reply(res, json(200, { artifacts: [...byPath.values()] }))
    }

    // —— 会话级授权列表：面板必须显示真实授权，而不是永远"尚未授权" ——
    const gl = /^\/api\/sessions\/([^/]+)\/grants$/.exec(url.pathname)
    if (req.method === 'GET' && gl) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(gl[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      return reply(res, json(200, { grants: grants.list({ tenantId: ctx.tenantId, sessionId }) }))
    }

    // —— 审计读取：audit_log 之前只写不读（SECURITY.md 记的缺口），补一个租户内只读视图 ——
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const limitRaw = Number(url.searchParams.get('limit') ?? 50)
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 50, 1), 200)
      const rows = db
        .prepare('select id, tenant_id, actor, action, detail_json, ts from audit_log where tenant_id = ? order by rowid desc limit ?')
        .all(ctx.tenantId, limit)
      const items = rows.map((r) => {
        let detail = null
        try { detail = JSON.parse(r.detail_json) } catch {}
        return { id: r.id, actor: r.actor, action: r.action, detail, ts: r.ts }
      })
      return reply(res, json(200, { audit: items, limit }))
    }

    // —— 运行时设置（只读、脱敏）：告诉运维"现在到底跑着什么配置" ——
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const keepDays = Number(process.env.RETENTION_DAYS ?? 30)
      const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
      return reply(res, json(200, {
        tenantId: ctx.tenantId,
        version: BOOT_SHA,
        driver: { name: driver.name, real: !driver.name.startsWith('fake') },
        limits: LIMITS,
        maxBodyBytes: MAX_BODY,
        retentionDays: Number.isFinite(keepDays) ? keepDays : null,
        upgrade: { testGate: process.env.UPGRADE_RUN_TESTS === '1', exitAfter: process.env.UPGRADE_EXIT_AFTER === '1' },
        startedAt,
        // 明确不返回：令牌、口令、模型密钥、DB 绝对路径
      }))
    }

    // —— 全部产物（跨会话，租户内）：/artifacts 页面的数据源 ——
    if (req.method === 'GET' && url.pathname === '/api/artifacts') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const limitRaw = Number(url.searchParams.get('limit') ?? 100)
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100, 1), 500)
      const rows = db
        .prepare(
          `select e.run_id, e.payload_json, e.ts, r.session_id
           from events e join runs r on r.id = e.run_id
           where e.type = 'artifact.created' and r.tenant_id = ?
           order by e.rowid desc limit ?`,
        )
        .all(ctx.tenantId, limit)
      const seen = new Set()
      const items = []
      for (const row of rows) {
        let p = {}
        try { p = JSON.parse(row.payload_json) } catch {}
        const key = `${row.run_id}:${p.path}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({ runId: row.run_id, sessionId: row.session_id, path: p.path, mime: p.mime ?? null, size: p.size ?? null, ts: row.ts })
      }
      return reply(res, json(200, { artifacts: items, limit }))
    }

    // —— 会话内待审批：刷新/重开页面后仍能把审批卡还原出来 ——
    const pd = /^\/api\/sessions\/([^/]+)\/pending$/.exec(url.pathname)
    if (req.method === 'GET' && pd) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(pd[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const runs = db
        .prepare("select id from runs where tenant_id = ? and session_id = ? and status = 'waiting_approval' order by started_at")
        .all(ctx.tenantId, sessionId)
      const pending = []
      for (const r of runs) {
        const ev = db
          .prepare("select payload_json from events where run_id = ? and type = 'approval.requested' order by seq desc limit 1")
          .get(r.id)
        if (!ev) continue
        let p = {}
        try { p = JSON.parse(ev.payload_json) } catch {}
        pending.push({ runId: r.id, callId: p.callId ?? null, tool: p.action ?? null, target: p.target ?? null, impact: p.impact ?? null, args: p.args ?? null })
      }
      return reply(res, json(200, { pending }))
    }

    // —— 总览：只读聚合（租户内），给 /overview 页面用 ——
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const t = ctx.tenantId
      const one = (sql) => db.prepare(sql).get(t)?.c ?? 0
      const byStatus = Object.fromEntries(
        db.prepare('select status, count(*) c from runs where tenant_id = ? group by status').all(t).map((r) => [r.status, r.c]),
      )
      const pending = db
        .prepare("select id, session_id, started_at from runs where tenant_id = ? and status = 'waiting_approval' order by started_at desc limit 5")
        .all(t)
        .map((r) => {
          const ev = db
            .prepare("select payload_json from events where run_id = ? and type = 'approval.requested' order by seq desc limit 1")
            .get(r.id)
          let tool = null
          let target = null
          try {
            const pl = JSON.parse(ev?.payload_json ?? '{}')
            tool = pl.action ?? null
            target = pl.target ?? null
          } catch {}
          return { runId: r.id, sessionId: r.session_id, startedAt: r.started_at, tool, target }
        })
      const audit = db.prepare('select actor, action, ts from audit_log where tenant_id = ? order by id desc limit 8').all(t)
      return reply(res, json(200, {
        tenantId: t,
        build: BOOT_SHA,
        driver: { name: driver.name, real: !driver.name.startsWith('fake') },
        counts: {
          sessions: one('select count(*) c from sessions where tenant_id = ?'),
          messages: one('select count(*) c from messages where tenant_id = ?'),
          grants: one('select count(*) c from session_grants where tenant_id = ?'),
          audit: one('select count(*) c from audit_log where tenant_id = ?'),
          runs: byStatus,
          runsTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
        },
        pending,
        audit,
      }))
    }

    // —— 静态前端 ——
    if (
      req.method === 'GET' &&
      (url.pathname === '/' ||
        url.pathname === '/overview' ||
        url.pathname === '/artifacts' ||
        url.pathname === '/settings' ||
        /^\/((app|overview|artifacts|settings)\.(js|css)|favicon\.svg)$/.test(url.pathname) ||
        /^\/fonts\/(montserrat-(light|regular|medium)\.woff2|Montserrat-OFL\.txt)$/.test(url.pathname))
    ) {
      const file =
        url.pathname === '/' ? 'index.html'
        : url.pathname === '/overview' ? 'overview.html'
        : url.pathname === '/artifacts' ? 'artifacts.html'
        : url.pathname === '/settings' ? 'settings.html'
        : url.pathname.slice(1)
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
      const qt = url.searchParams.get('token')
      const ctx = qt ? resolveContext(`Bearer ${qt}`) : ctxOf(req)
      if (ctx.error) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthenticated"}') }
      const runId = decodeURIComponent(evm[1])
      if (!rc.status(runId)) { res.writeHead(404); return res.end() }
      // 租户归属：事件流里有工具参数、目标路径与助手文本，跨租户一律 404
      const evOwner = db.prepare('select tenant_id from runs where id = ?').get(runId)
      if (!evOwner || evOwner.tenant_id !== ctx.tenantId) { res.writeHead(404); return res.end() }
      const lastEventId = parseLastEventId(req.headers['last-event-id'], url.searchParams.get('lastEventId'))
      // replay=1：只回放快照后关闭（轮询/测试用）；默认保持长连接实时推送
      if (url.searchParams.get('replay') === '1') {
        return handleEventsRequest({ res, log, runId, lastEventId })
      }
      return handleLiveEvents({ req, res, log, rc, runId, lastEventId })
    }

    // —— 创建 run（跑到审批处停下）——
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const body = await readJson(req)
      const sessionId = String(body.sessionId ?? 's_a1')
      // 会话归属必须与 tenant 一致，否则按不存在处理（不泄露是否存在）
      const owned = db
        .prepare('select 1 from sessions where id = ? and tenant_id = ?')
        .get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))

      const runId = `r${Date.now()}${(seq++).toString(36)}`
      // 模型 loop：事件序列由 driver 决策产生，不是硬编码；跑到审批处会挂起
      metrics.inc('runs_created_total', { driver: driver.name.startsWith('fake') ? 'fake' : 'real' })
      await loop.start({ runId, tenantId: ctx.tenantId, sessionId, input: String(body.input ?? '') })
      return reply(res, json(202, { runId, sessionId, driver: driver.name }))
    }

    // —— 会话深链：/c/:sessionId → /?sid=…（文档 §7.1 的欠账，用最小改动补上）——
    const deep = /^\/c\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && deep) {
      const sid = decodeURIComponent(deep[1])
      res.writeHead(302, { location: `/?sid=${encodeURIComponent(sid)}`, 'cache-control': 'no-store' })
      return res.end()
    }

    // —— 会话历史（刷新页面后恢复）——
    const hist = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (req.method === 'GET' && hist) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(hist[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const rows = db
        .prepare('select role, content, created_at from messages where tenant_id = ? and session_id = ? order by rowid asc')
        .all(ctx.tenantId, sessionId)
      return reply(res, json(200, { messages: rows }))
    }

    // —— 新建会话（验收与前端都需要；租户由 ctx 决定，不接受外部指定）——
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const body = await readJson(req)
      const id = `s_${Math.random().toString(16).slice(2, 10)}`
      const title = String(body.title ?? '新会话').slice(0, 60)
      db.prepare('insert into sessions (id, tenant_id, user_id, title) values (?, ?, ?, ?)').run(id, ctx.tenantId, ctx.userId, title)
      return reply(res, json(201, { id, title }))
    }

    // —— 会话删除（DELETE）：级联清理 messages/runs/events/grants/pending/tool_results ——
    if (req.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sid = decodeURIComponent(url.pathname.split('/').pop())
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sid, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      // 有活动 run 时拒绝：先取消再删，避免把正在跑的东西从下面抽走
      const active = db
        .prepare("select count(*) c from runs where tenant_id = ? and session_id = ? and status in ('running','waiting_approval','queued')")
        .get(ctx.tenantId, sid).c
      if (active > 0) return reply(res, json(409, { error: 'has_active_runs', active }))
      const runIds = db.prepare('select id from runs where tenant_id = ? and session_id = ?').all(ctx.tenantId, sid).map((r) => r.id)
      let removed = { messages: 0, runs: 0, events: 0, grants: 0, pending: 0, toolResults: 0 }
      db.exec('begin')
      try {
        for (const rid of runIds) {
          removed.events += Number(db.prepare('delete from events where run_id = ?').run(rid).changes ?? 0)
          removed.toolResults += Number(db.prepare('delete from run_tool_results where run_id = ?').run(rid).changes ?? 0)
        }
        removed.pending = Number(db.prepare('delete from run_pending where tenant_id = ? and session_id = ?').run(ctx.tenantId, sid).changes ?? 0)
        removed.grants = Number(db.prepare('delete from session_grants where tenant_id = ? and session_id = ?').run(ctx.tenantId, sid).changes ?? 0)
        removed.messages = Number(db.prepare('delete from messages where tenant_id = ? and session_id = ?').run(ctx.tenantId, sid).changes ?? 0)
        removed.runs = Number(db.prepare('delete from runs where tenant_id = ? and session_id = ?').run(ctx.tenantId, sid).changes ?? 0)
        db.prepare('delete from sessions where id = ? and tenant_id = ?').run(sid, ctx.tenantId)
        db.prepare('insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?,?,?,?,?)')
          .run(ctx.tenantId, ctx.userId, 'session_deleted', JSON.stringify({ sessionId: sid, removed }), new Date().toISOString())
        db.exec('commit')
      } catch (e) {
        try { db.exec('rollback') } catch {}
        return reply(res, json(500, { error: 'delete_failed', message: String(e.message ?? e) }))
      }
      return reply(res, json(200, { deleted: true, sessionId: sid, removed }))
    }

    // —— 会话重命名（PATCH）：列表里全是"验收会话"时，改个名字比新建一百个有用 ——
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/sessions/') && !url.pathname.includes('/grants')) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const pm = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
      if (!pm) return reply(res, json(404, { error: 'not_found' }))
      const sid = decodeURIComponent(pm[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sid, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const body = await readJson(req)
      const raw = String(body.title ?? '').trim()
      if (!raw || raw.length > 60) return reply(res, json(400, { error: 'invalid_title', limit: 60 }))
      db.prepare('update sessions set title = ? where id = ? and tenant_id = ?').run(raw, sid, ctx.tenantId)
      return reply(res, json(200, { id: sid, title: raw }))
    }

    // —— 撤销会话级授权（已知缺口补口：v16 明确写过"撤销口径缺失"）——
    const rv = /^\/api\/sessions\/([^/]+)\/grants\/revoke$/.exec(url.pathname)
    if (req.method === 'POST' && rv) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const sessionId = decodeURIComponent(rv[1])
      const owned = db.prepare('select 1 from sessions where id = ? and tenant_id = ?').get(sessionId, ctx.tenantId)
      if (!owned) return reply(res, json(404, { error: 'not_found' }))
      const body = await readJson(req)
      const revoked = grants.revoke({ tenantId: ctx.tenantId, sessionId, tool: body.tool ? String(body.tool) : null })
      if (revoked > 0) metrics.inc('grants_revoked_total', {}, revoked)
      db.prepare('insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)')
        .run(ctx.tenantId, ctx.userId, 'session_grant_revoked', JSON.stringify({ sessionId, tool: body.tool ?? '*' , revoked }), new Date().toISOString())
      return reply(res, json(200, { revoked }))
    }

    // —— 取消 run（文档 §2.2 可取消）——
    const cn = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
    if (req.method === 'POST' && cn) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const runId = decodeURIComponent(cn[1])
      const run = db.prepare('select tenant_id from runs where id = ?').get(runId)
      if (!run || run.tenant_id !== ctx.tenantId) return reply(res, json(404, { error: 'not_found' }))
      return reply(res, json(200, loop.cancel(runId)))
    }

    // —— 审批回写 ——
    const ap = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && ap) {
      const ctx = ctxOf(req)
      if (ctx.error) return reply(res, ctx.error)
      const runId = decodeURIComponent(ap[1])
      if (!rc.status(runId)) return reply(res, json(404, { error: 'not_found' }))
      // 租户归属校验：跨租户一律 404，不能"知道 runId 就能批"
      const owner = db.prepare('select tenant_id from runs where id = ?').get(runId)
      if (!owner || owner.tenant_id !== ctx.tenantId) return reply(res, json(404, { error: 'not_found' }))
      const body = await readJson(req)
      const decision = ['deny', 'allow_session'].includes(body.decision) ? body.decision : 'allow_once'
      const pendingEv = db
        .prepare("select payload_json from events where run_id = ? and type = 'approval.requested' order by seq desc limit 1")
        .get(runId)
      let tool = null
      try { tool = JSON.parse(pendingEv?.payload_json ?? '{}').action ?? null } catch {}
      metrics.inc('approvals_total', { decision })
      const out = await loop.resume({ runId, decision })
      db.prepare('insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)')
        .run(ctx.tenantId, ctx.userId, 'approval_decided', JSON.stringify({ runId, decision, tool }), new Date().toISOString())
      return reply(res, json(200, { ...out, decision }))
    }

    // —— 升级 ——
    if (req.method === 'POST' && url.pathname === '/api/admin/upgrade') {
      const allow = (process.env.UPGRADE_ALLOW_IPS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      if (allow.length > 0 && !allow.includes(clientIp(req))) {
        return reply(res, json(403, { error: 'ip_not_allowed' }))
      }
      const result = await upgradeRoute(req)
      reply(res, result)
      if (result.status === 200 && result.body?.upToDate === false && process.env.UPGRADE_EXIT_AFTER === '1') {
        res.on('finish', () => setTimeout(() => { console.log('[cube-agent] upgrade applied, exiting for restart'); process.exit(0) }, 200))
      }
      return
    }

    reply(res, handleRequest(db, req, ctxOf))
  })
}

function reply(res, { status, body }) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// 直接运行时监听（测试不经过这里）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { openDb, seedTwoTenants } = await import('./db.mjs')
  const dbPath = process.env.DB_PATH ?? '/var/lib/cube-agent/cube.db'
  const db = openDb(dbPath)
  console.log(`[cube-agent] db: ${dbPath}`)
  seedTwoTenants(db)
  if (TOKEN_SOURCE === 'dev-defaults') {
    console.warn('[cube-agent] WARN: 使用开发默认 token（tok_a/tok_b）。公网部署必须设置 CUBE_TOKENS。')
  }
  const port = Number(process.env.PORT ?? 8787)
  createApp(db).listen(port, () => console.log(`cube-agent gateway on http://127.0.0.1:${port}`))
}
