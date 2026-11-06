// 事件日志：一切输出都是事件，seq 在 run 内单调递增（对齐文档 §2.2 / §6 events 表）。
// 关键顺序：先落库拿到 seq，再发送。反过来会在重连时丢掉终态事件。
export class EventLog {
  constructor(db) {
    this.db = db
  }

  nextSeq(runId) {
    const row = this.db.prepare('select coalesce(max(seq), 0) as m from events where run_id = ?').get(runId)
    return Number(row.m) + 1
  }

  append(runId, type, payload = {}) {
    // 序号分配必须与插入是同一条语句：先 max(seq)+1 再 insert 是"读后写"，
    // 两个连接同时追加时会撞 (run_id, seq) 主键（多进程/重启重叠时真实可发生）
    const row = this.db
      .prepare(
        `insert into events (run_id, seq, type, payload_json, ts)
         values (?, (select coalesce(max(seq), 0) + 1 from events where run_id = ?), ?, ?, ?)
         returning seq`,
      )
      .get(runId, runId, type, JSON.stringify(payload), new Date().toISOString())
    return Number(row.seq)
  }

  // afterSeq 的语义：调用方已收到的最大 seq；只回放严格大于它的
  after(runId, afterSeq = 0) {
    return this.db
      .prepare('select seq, type, payload_json from events where run_id = ? and seq > ? order by seq asc')
      .all(runId, afterSeq)
      .map((r) => ({ seq: Number(r.seq), type: r.type, payload: JSON.parse(r.payload_json) }))
  }

  lastSeq(runId) {
    const row = this.db.prepare('select coalesce(max(seq), 0) as m from events where run_id = ?').get(runId)
    return Number(row.m)
  }
}
