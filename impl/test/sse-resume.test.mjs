import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { openDb, seedTwoTenants } from '../src/db.mjs'
import { EventLog } from '../src/events.mjs'
import { RunController } from '../src/runs.mjs'
import { framesAfter, parseLastEventId, handleEventsRequest } from '../src/sse.mjs'

function fresh() {
  const db = openDb()
  seedTwoTenants(db)
  return { db, log: new EventLog(db), rc: new RunController(db, new EventLog(db)) }
}
function setup() {
  const db = openDb()
  seedTwoTenants(db)
  const log = new EventLog(db)
  const rc = new RunController(db, log)
  return { db, log, rc }
}

test('事件 seq 从 1 单调递增，终态是 run.finished', () => {
  const { log, rc } = setup()
  rc.create('r1')
  const last = rc.drive('r1')
  const evs = log.after('r1', 0)
  assert.deepEqual(evs.map((e) => e.seq), Array.from({ length: evs.length }, (_, i) => i + 1))
  assert.equal(evs.at(-1).type, 'run.finished')
  assert.equal(last, evs.length)
})

test('Last-Event-ID 续传：只回放 seq > last，不重复', () => {
  const { log, rc } = setup()
  rc.create('r2')
  rc.drive('r2')
  const all = log.after('r2', 0)
  const mid = 3
  const rest = log.after('r2', mid)
  assert.ok(rest.length > 0)
  assert.equal(rest[0].seq, mid + 1)
  // 拼回去必须等于全量，且没有重复 seq
  const joined = [...all.slice(0, mid), ...rest]
  assert.deepEqual(joined.map((e) => e.seq), all.map((e) => e.seq))
  assert.equal(new Set(joined.map((e) => e.seq)).size, joined.length)
})

test('已到终态再续传：返回 0 帧（不重放已完成事件）', () => {
  const { log, rc } = setup()
  rc.create('r3')
  const last = rc.drive('r3')
  assert.deepEqual(log.after('r3', last), [])
  assert.equal(framesAfter(log, 'r3', last).length, 0)
})

test('非法状态迁移必须抛错（queued → done 不允许跳）', () => {
  const { rc } = setup()
  rc.create('r4')
  assert.throws(() => rc.transition('r4', 'done'), /illegal transition: queued -> done/)
})

test('审批拒绝 → run.canceled，且不再有 run.finished', () => {
  const { log, rc } = setup()
  rc.create('r5')
  rc.drive('r5', { approve: false })
  const evs = log.after('r5', 0)
  assert.equal(evs.at(-1).type, 'run.canceled')
  assert.equal(evs.some((e) => e.type === 'run.finished'), false)
})

test('失败路径 → run.failed 落库后才可读', () => {
  const { log, rc } = setup()
  rc.create('r6')
  rc.drive('r6', { fail: true })
  assert.equal(rc.status('r6'), 'failed')
  assert.equal(log.after('r6', 0).at(-1).type, 'run.failed')
})

test('终态后再 cancel 必须拒绝', () => {
  const { rc } = setup()
  rc.create('r7')
  rc.drive('r7')
  assert.throws(() => rc.cancel('r7'), /already terminal/)
})

test('HTTP：带 Last-Event-ID 头只回放其后事件', async () => {
  const { log, rc } = setup()
  rc.create('r8')
  rc.drive('r8')

  const server = createServer((req, res) => {
    const runId = new URL(req.url, 'http://local').pathname.split('/')[3]
    const last = parseLastEventId(req.headers['last-event-id'], null)
    handleEventsRequest({ res, log, runId, lastEventId: last })
  })
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port

  const full = await (await fetch(`http://127.0.0.1:${port}/api/runs/r8/events`)).text()
  const resumed = await (
    await fetch(`http://127.0.0.1:${port}/api/runs/r8/events`, { headers: { 'last-event-id': '5' } })
  ).text()

  server.close()

  const ids = [...full.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
  const rIds = [...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
  assert.ok(ids.length > 5)
  assert.deepEqual(rIds, ids.filter((n) => n > 5))
  assert.equal(new Set(rIds).size, rIds.length)
})
