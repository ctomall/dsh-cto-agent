#!/usr/bin/env node
// 用法：
//   node scripts/maintenance.mjs [--db PATH] [--report|--prune-events N]
import { dbStats, pruneEvents } from '../impl/src/maintenance.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const dbPath = arg('--db', process.env.DB_PATH ?? '/var/lib/cube-agent/cube.db')

const fmt = (b) => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`

if (argv.includes('--prune-events')) {
  const days = Number(arg('--prune-events', '30'))
  const r = pruneEvents(dbPath, { days })
  console.log(`清理事件：删除 ${r.deleted} 行（早于 ${r.cutoff}，仅终态 run）`)
} else {
  const s = dbStats(dbPath)
  console.log(`库体积：${fmt(s.bytes)}（空闲页 ${fmt(s.freeBytes)}）`)
  for (const [t, c] of Object.entries(s.tables)) console.log(`  ${t.padEnd(18)} ${c ?? '-'}`)
}
