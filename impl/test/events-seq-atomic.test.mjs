import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 真正跨进程：两个进程同时向同一个 run 追加事件，序号必须唯一且连续。
// 旧实现是"select max+1 再 insert"，跨进程会撞 (run_id, seq) 主键。
const CHILD = `
import { DatabaseSync } from 'node:sqlite'
const [dbPath, runId, n] = [process.argv[2], process.argv[3], Number(process.argv[4])]
const db = new DatabaseSync(dbPath)
db.exec("pragma journal_mode=wal; pragma busy_timeout=5000")
const { EventLog } = await import(process.argv[5])
const log = new EventLog(db)
let busy = 0, conflicts = 0
for (let i = 0; i < n; i++) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { log.append(runId, 'child.event', { i }); break } catch (e) {
      const msg = String(e.message ?? e)
      if (/SQLITE_BUSY|database is locked/i.test(msg)) { busy += 1; await new Promise((r) => setTimeout(r, 20)); continue }
      conflicts += 1 // 真正的序号冲突（主键）才是我们关心的失败
      break
    }
  }
}
db.close()
// 只有"主键冲突"才算失败；BUSY 是负载下的正常竞争（有 busy_timeout，但机器极忙时仍可能超时）
process.exit(conflicts === 0 ? 0 : 1)
`

test('跨进程并发追加：seq 不重复、不空洞、无主键冲突', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seqp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'cube.db')
  const childPath = join(dir, 'child.mjs')
  writeFileSync(childPath, CHILD)

  const setup = new DatabaseSync(dbPath)
  setup.exec('pragma journal_mode=wal')
  setup.exec('create table events (run_id text not null, seq integer not null, type text not null, payload_json text not null, ts text not null, primary key (run_id, seq))')
  setup.close()

  const eventsModule = new URL('../src/events.mjs', import.meta.url).pathname
  const N = 2, PER = 120
  const runs = Array.from({ length: N }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [childPath, dbPath, 'r_multi', String(PER), eventsModule], { stdio: 'ignore' })
    p.on('exit', (code) => resolve(code))
  }))
  const codes = await Promise.all(runs)
  assert.deepEqual(codes, Array(N).fill(0), `有子进程因序号冲突失败：exit=${codes.join(',')}`)

  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('select seq from events where run_id = ? order by seq').all('r_multi')
  db.close()
  const seqs = rows.map((r) => Number(r.seq))
  assert.equal(seqs.length, N * PER, `事件条数不符：${seqs.length}`)
  assert.equal(new Set(seqs).size, seqs.length, `seq 重复：${seqs.join(',')}`)
  assert.deepEqual(seqs, Array.from({ length: N * PER }, (_, i) => i + 1), `seq 不连续：${seqs.join(',')}`)
})
