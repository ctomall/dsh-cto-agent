// token → RequestContext（对齐文档 §2.4「每次请求由 Gateway 解析并注入」）。
// 401 只用于「没有身份」；身份有效但资源不可达一律 404（不区分越权与不存在）。
// 开发默认值：只在没有注入 CUBE_TOKENS 时使用；公开部署必须注入，否则等于把测试凭据暴露到公网。
const DEV_TOKENS = new Map([
  ['tok_a', { tenantId: 't_a', userId: 'u_a' }],
  ['tok_b', { tenantId: 't_b', userId: 'u_b' }],
])

export function loadTokens(env = process.env) {
  if (!env.CUBE_TOKENS) return { source: 'dev-defaults', tokens: new Map(DEV_TOKENS) }
  const parsed = JSON.parse(env.CUBE_TOKENS)
  const tokens = new Map(Object.entries(parsed))
  if (tokens.size === 0) throw new Error('CUBE_TOKENS 解析后为空，拒绝启动')
  return { source: 'env', tokens }
}

export const TOKEN_SOURCE = loadTokens().source
const TOKENS = loadTokens().tokens

export const UNAUTHENTICATED = { status: 401, body: { error: 'unauthenticated' } }

export function resolveContext(authorization, tokens = TOKENS) {
  if (typeof authorization !== 'string') return { error: UNAUTHENTICATED }
  const m = /^Bearer\s+(\S+)$/.exec(authorization.trim())
  if (!m) return { error: UNAUTHENTICATED }
  const ident = tokens.get(m[1])
  if (!ident) return { error: UNAUTHENTICATED }
  return { tenantId: ident.tenantId, userId: ident.userId, permissions: [] }
}

export function auditDenial(db, ctx, action, detail) {
  db.prepare(
    'insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)',
  ).run(ctx.tenantId, ctx.userId, action, JSON.stringify(detail), new Date().toISOString())
}
