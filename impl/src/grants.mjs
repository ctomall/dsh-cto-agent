// 会话级授权：只在 (tenant, session, tool) 命中时复用；跨会话、跨租户一律不继承。
export function createGrants(db) {
  return {
    has({ tenantId, sessionId, tool }) {
      // 只有 scope='session' 才算"本会话允许"。
      // 其它 scope（例如将来可能出现的一次性授权）绝不能因为"表里有行"就自动放行。
      return !!db
        .prepare("select 1 from session_grants where tenant_id = ? and session_id = ? and tool = ? and scope = 'session'")
        .get(tenantId, sessionId, tool)
    },
    add({ tenantId, sessionId, tool }) {
      db.prepare(
        'insert or replace into session_grants (tenant_id, session_id, tool, scope, granted_at) values (?, ?, ?, ?, ?)',
      ).run(tenantId, sessionId, tool, 'session', new Date().toISOString())
    },
    revoke({ tenantId, sessionId, tool = null }) {
      const info = tool
        ? db.prepare('delete from session_grants where tenant_id = ? and session_id = ? and tool = ?').run(tenantId, sessionId, tool)
        : db.prepare('delete from session_grants where tenant_id = ? and session_id = ?').run(tenantId, sessionId)
      return Number(info.changes ?? 0)
    },
    list({ tenantId, sessionId }) {
      return db
        .prepare('select tool, scope, granted_at from session_grants where tenant_id = ? and session_id = ? order by tool')
        .all(tenantId, sessionId)
    },
  }
}
