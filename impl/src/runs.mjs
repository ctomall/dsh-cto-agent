// run 状态机 + 事件发射（对齐文档 §2.2：queued → running → waiting_approval → running → done|failed|canceled）
export const TERMINAL = new Set(['done', 'failed', 'canceled'])

const ALLOWED = {
  queued: ['running', 'canceled'],
  running: ['waiting_approval', 'done', 'failed', 'canceled'],
  waiting_approval: ['running', 'canceled'],
  done: [],
  failed: [],
  canceled: [],
}

export class RunController {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  create(runId) {
    this.db.prepare('insert into runs (id, status, started_at) values (?, ?, ?)').run(runId, 'queued', new Date().toISOString())
    this.log.append(runId, 'run.started', { runId })
    return runId
  }

  status(runId) {
    return this.db.prepare('select status from runs where id = ?').get(runId)?.status
  }

  transition(runId, to) {
    const from = this.status(runId)
    if (!from) throw new Error(`unknown run: ${runId}`)
    const allowed = ALLOWED[from] ?? []
    if (!allowed.includes(to)) throw new Error(`illegal transition: ${from} -> ${to}`)
    this.db.prepare('update runs set status = ? where id = ?').run(to, runId)
    return to
  }

  // 最小可用的 stub loop：同步驱动，只用于验证传输层与状态机，不冒充真实 agent
  drive(runId, { approve = true, fail = false } = {}) {
    this.transition(runId, 'running')
    this.log.append(runId, 'text.delta', { text: '开始执行…' })

    this.log.append(runId, 'tool.started', { tool: 'shell.exec', callId: `${runId}-c1` })
    this.transition(runId, 'waiting_approval')
    this.log.append(runId, 'approval.requested', { callId: `${runId}-c1`, action: 'shell.exec' })

    if (!approve) {
      this.log.append(runId, 'approval.decided', { callId: `${runId}-c1`, decision: 'deny' })
      this.transition(runId, 'canceled')
      this.log.append(runId, 'run.canceled', { runId })
      return this.log.lastSeq(runId)
    }

    this.log.append(runId, 'approval.decided', { callId: `${runId}-c1`, decision: 'allow_once' })
    this.transition(runId, 'running')
    this.log.append(runId, 'tool.finished', { callId: `${runId}-c1`, ok: !fail, truncated: false })
    this.log.append(runId, 'artifact.created', { path: 'out/report.md', mime: 'text/markdown' })

    if (fail) {
      this.transition(runId, 'failed')
      this.log.append(runId, 'run.failed', { runId, error: 'stub failure' })
    } else {
      this.transition(runId, 'done')
      this.log.append(runId, 'run.finished', { runId, ok: true })
    }
    return this.log.lastSeq(runId)
  }

  cancel(runId) {
    if (TERMINAL.has(this.status(runId))) throw new Error(`run already terminal: ${runId}`)
    this.transition(runId, 'canceled')
    this.log.append(runId, 'run.canceled', { runId })
    return this.log.lastSeq(runId)
  }
}
