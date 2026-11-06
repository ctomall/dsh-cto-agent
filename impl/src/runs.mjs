// run 状态机 + 事件发射（对齐文档 §2.2：queued → running → waiting_approval → running → done|failed|canceled）
export const TERMINAL = new Set(['done', 'failed', 'canceled'])

const ALLOWED = {
  queued: ['running', 'canceled'],
  running: ['waiting_approval', 'done', 'failed', 'canceled'],
  waiting_approval: ['running', 'canceled', 'failed'],
  done: [],
  failed: [],
  canceled: [],
}

import { EventEmitter } from 'node:events'

export class RunController {
  constructor(db, log) {
    this.db = db
    this.log = log
    this.bus = new EventEmitter()   // 实时推送用；先落库再发，订阅者拿到的一定已在库里
    this.bus.setMaxListeners(0)
  }

  emitTo(runId, type, payload) {
    const seq = this.log.append(runId, type, payload)
    this.bus.emit(runId, { seq, type, payload })
    return seq
  }

  create(runId, { tenantId = null, sessionId = null, driver = null } = {}) {
    this.db
      .prepare('insert into runs (id, status, started_at, tenant_id, session_id) values (?, ?, ?, ?, ?)')
      .run(runId, 'queued', new Date().toISOString(), tenantId, sessionId)
    // 把"谁在驱动这次 run"写进事件：否则事后没人能分辨这是演示驱动还是真实模型
    this.emitTo(runId, 'run.started', { runId, ...(driver ? { driver, real: !String(driver).startsWith('fake') } : {}) })
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
    // 进入终态时补写 ended_at：否则这条列只有失败路径会写，时长统计永远缺一半
    if (['done', 'failed', 'canceled'].includes(to)) {
      this.db.prepare('update runs set status = ?, ended_at = ? where id = ?').run(to, new Date().toISOString(), runId)
    } else {
      this.db.prepare('update runs set status = ? where id = ?').run(to, runId)
    }
    return to
  }

  // 最小可用的 stub loop：同步驱动，只用于验证传输层与状态机，不冒充真实 agent
  drive(runId, { approve = true, fail = false } = {}) {
    this.transition(runId, 'running')
    this.emitTo(runId, 'text.delta', { text: '开始执行…' })

    this.emitTo(runId, 'tool.started', { tool: 'shell.exec', callId: `${runId}-c1` })
    this.transition(runId, 'waiting_approval')
    this.emitTo(runId, 'approval.requested', { callId: `${runId}-c1`, action: 'shell.exec' })

    if (!approve) {
      this.emitTo(runId, 'approval.decided', { callId: `${runId}-c1`, decision: 'deny' })
      this.transition(runId, 'canceled')
      this.emitTo(runId, 'run.canceled', { runId })
      return this.log.lastSeq(runId)
    }

    this.emitTo(runId, 'approval.decided', { callId: `${runId}-c1`, decision: 'allow_once' })
    this.transition(runId, 'running')
    this.emitTo(runId, 'tool.finished', { callId: `${runId}-c1`, ok: !fail, truncated: false })
    this.emitTo(runId, 'artifact.created', { path: 'out/report.md', mime: 'text/markdown' })

    if (fail) {
      this.transition(runId, 'failed')
      this.emitTo(runId, 'run.failed', { runId, error: 'stub failure' })
    } else {
      this.transition(runId, 'done')
      this.emitTo(runId, 'run.finished', { runId, ok: true })
    }
    return this.log.lastSeq(runId)
  }

  // 审批决定 → 恢复或拒绝
  decideApproval(runId, decision) {
    const callId = `${runId}-c1`
    this.emitTo(runId, 'approval.decided', { callId, decision })
    if (decision === 'deny') {
      this.transition(runId, 'canceled')
      this.emitTo(runId, 'run.canceled', { runId })
      return { decision, status: 'canceled' }
    }
    this.transition(runId, 'running')
    this.emitTo(runId, 'tool.finished', { callId, ok: true, truncated: false })
    this.emitTo(runId, 'artifact.created', { path: 'report.md', mime: 'text/markdown', size: 2048 })
    this.transition(runId, 'done')
    this.emitTo(runId, 'run.finished', { runId, ok: true })
    return { decision, status: 'done' }
  }

  cancel(runId) {
    if (TERMINAL.has(this.status(runId))) throw new Error(`run already terminal: ${runId}`)
    this.transition(runId, 'canceled')
    this.emitTo(runId, 'run.canceled', { runId })
    return this.log.lastSeq(runId)
  }
}
