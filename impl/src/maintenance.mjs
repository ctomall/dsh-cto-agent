// 运维：库体积与行数报告 + 事件表安全清理（只清终态 run 的旧事件，审计永不删）
import { DatabaseSync } from 'node:sqlite'

export const TABLES = [
  'tenants', 'users', 'sessions', 'messages', 'runs', 'events',
  'audit_log', 'session_grants', 'run_pending', 'run_tool_results',
]

export function dbStats(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const pageSize = Number(db.prepare('pragma page_size').get().page_size)
    const pageCount = Number(db.prepare('pragma page_count').get().page_count)
    const freePages = Number(db.prepare('pragma freelist_count').get().freelist_count)
    const tables = {}
    for (const t of TABLES) {
      try { tables[t] = Number(db.prepare(`select count(*) c from ${t}`).get().c) } catch { tables[t] = null }
    }
    return { bytes: pageSize * pageCount, freeBytes: pageSize * freePages, tables }
  } finally {
    db.close()
  }
}

export function pruneEvents(dbPath, { days = 30, now = new Date() } = {}) {
  const db = new DatabaseSync(dbPath)
  try {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
    // 只动「已终止 run」的事件：还在跑/等审批的 run 必须保留完整回放
    const info = db
      .prepare(
        `delete from events
         where ts < ?
           and run_id in (select id from runs where status in ('done','failed','canceled'))`,
      )
      .run(cutoff)
    return { deleted: Number(info.changes ?? 0), cutoff, days }
  } finally {
    db.close()
  }
}
