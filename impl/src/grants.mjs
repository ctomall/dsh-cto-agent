// 会话级授权：只在 (tenant, session, tool) 命中时复用；跨会话、跨租户一律不继承。
export function createGrants(db) {
  return {
    has({ tenantId, sessionId, tool }) {
      return !!db
        .prepare('select 1 from session_grants where tenant_id = ? and session_id = ? and tool = ?')
        .get(tenantId, sessionId, tool)
    },
    add({ tenantId, sessionId, tool }) {
      db.prepare(
        'insert or replace into session_grants (tenant_id, session_id, tool, scope, granted_at) values (?, ?, ?, ?, ?)',
      ).run(tenantId, sessionId, tool, 'session', new Date().toISOString())
    },
    list({ tenantId, sessionId }) {
      return db
        .prepare('select tool, scope, granted_at from session_grants where tenant_id = ? and session_id = ? order by tool')
        .all(tenantId, sessionId)
    },
  }
}
