// 在线备份：SQLite `VACUUM INTO`（WAL 下安全，产出单文件），并逐表核对行数。
// 用途：自托管部署在升级/迁移前留一份可恢复快照。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const KEY_TABLES = [
  'tenants', 'users', 'sessions', 'messages', 'runs', 'events',
  'audit_log', 'session_grants', 'run_pending', 'run_tool_results',
]

export function countTables(dbPath, tables = KEY_TABLES) {
  // 表名只允许白名单，避免将来有人把外部输入传进来做 SQL 拼接
  const safe = tables.filter((t) => KEY_TABLES.includes(t))
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const out = {}
    for (const t of safe) {
      try { out[t] = Number(db.prepare(`select count(*) c from ${t}`).get().c) } catch { out[t] = null }
    }
    return out
  } finally {
    db.close()
  }
}

// 只保留最近 keep 份 cube-*.db，避免备份目录无限增长
export function pruneBackups(outDir, keep = 14) {
  if (!existsSync(outDir)) return []
  const files = readdirSync(outDir)
    .filter((f) => /^cube-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse()
  const removed = files.slice(keep)
  for (const f of removed) unlinkSync(join(outDir, f))
  return removed
}

export function backupDb({ dbPath, outDir, now = new Date(), keep = 14 } = {}) {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`)
  mkdirSync(outDir, { recursive: true })
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const outPath = join(outDir, `cube-${stamp}.db`)
  if (existsSync(outPath)) throw new Error(`目标已存在，拒绝覆盖: ${outPath}`)

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`vacuum into '${outPath.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }

  const source = countTables(dbPath)
  const copy = countTables(outPath)
  const mismatch = Object.keys(source).filter((t) => source[t] !== copy[t])
  const pruned = pruneBackups(outDir, keep)
  return {
    pruned,
    outPath,
    bytes: statSync(outPath).size,
    counts: copy,
    verified: mismatch.length === 0,
    mismatch,
  }
}
