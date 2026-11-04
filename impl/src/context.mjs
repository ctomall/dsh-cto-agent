// token → RequestContext（对齐文档 §2.4「每次请求由 Gateway 解析并注入」）。
// 401 只用于「没有身份」；身份有效但资源不可达一律 404（不区分越权与不存在）。
const TOKENS = new Map([
  ['tok_a', { tenantId: 't_a', userId: 'u_a' }],
  ['tok_b', { tenantId: 't_b', userId: 'u_b' }],
])

export const UNAUTHENTICATED = { status: 401, body: { error: 'unauthenticated' } }

export function resolveContext(authorization) {
  if (typeof authorization !== 'string') return { error: UNAUTHENTICATED }
  const m = /^Bearer\s+(\S+)$/.exec(authorization.trim())
  if (!m) return { error: UNAUTHENTICATED }
  const ident = TOKENS.get(m[1])
  if (!ident) return { error: UNAUTHENTICATED }
  return { tenantId: ident.tenantId, userId: ident.userId, permissions: [] }
}

export function auditDenial(db, ctx, action, detail) {
  db.prepare(
    'insert into audit_log (tenant_id, actor, action, detail_json, ts) values (?, ?, ?, ?, ?)',
  ).run(ctx.tenantId, ctx.userId, action, JSON.stringify(detail), new Date().toISOString())
}
