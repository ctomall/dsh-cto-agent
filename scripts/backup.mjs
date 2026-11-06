#!/usr/bin/env node
// 用法：node scripts/backup.mjs [--db /var/lib/cube-agent/cube.db] [--out /var/backups/cube-agent]
import { backupDb } from '../impl/src/backup.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const dbPath = arg('--db', process.env.DB_PATH ?? '/var/lib/cube-agent/cube.db')
const outDir = arg('--out', '/var/backups/cube-agent')

try {
  const r = backupDb({ dbPath, outDir })
  console.log(`备份完成: ${r.outPath}（${r.bytes} 字节）`)
  console.log('行数核对:', JSON.stringify(r.counts))
  if (!r.verified) {
    console.error('行数不一致:', r.mismatch.join(', '))
    process.exit(1)
  }
  console.log('校验: 通过（源库与副本逐表行数一致）')
} catch (e) {
  console.error('备份失败:', e.message)
  process.exit(1)
}
