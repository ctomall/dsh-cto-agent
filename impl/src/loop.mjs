// Agent loop：事件序列由模型决策驱动，审批处真正挂起，恢复后继续同一上下文。
import { TERMINAL } from './runs.mjs'
export class AgentLoop {
  constructor({ rc, tools, driver, workspaceRoot, grants = null, audit = null, store = null, loadHistory = null, historyLimit = 20, maxSteps = 10, timeoutMs = 120_000, pendingStore = null, toolResults = null }) {
    this.rc = rc
    this.tools = tools
    this.driver = driver
    this.workspaceRoot = workspaceRoot
    this.grants = grants
    this.audit = audit
    this.store = store
    this.loadHistory = loadHistory
    this.historyLimit = historyLimit
    this.timeoutMs = timeoutMs
    this.pendingStore = pendingStore
    this.toolResults = toolResults
    this.maxSteps = maxSteps
    this.pending = new Map() // runId -> { messages, call, callId, tenantId, sessionId }
    this.aborts = new Map() // runId -> { ctrl, reason }  （用户取消 / 超时共用）
  }

  async start({ runId, tenantId = null, sessionId = null, input }) {
    this.rc.create(runId, { tenantId, sessionId })
    this.rc.transition(runId, 'running')
    this.rc.emitTo(runId, 'text.delta', { text: `收到目标：${input}` })
    // 先读历史，再落本条 user 消息，避免自己把自己读进来重复一遍
    const prior = this.loadHistory?.({ tenantId, sessionId, limit: this.historyLimit }) ?? []
    this.store?.({ tenantId, sessionId, runId, role: 'user', content: input })
    const messages = [...prior, { role: 'user', content: input }]
    return this.step({ runId, messages, steps: 0, tenantId, sessionId })
  }

  async step({ runId, messages, steps, tenantId, sessionId }) {
    if (steps >= this.maxSteps) {
      this.rc.transition(runId, 'failed')
      this.rc.emitTo(runId, 'run.failed', { runId, error: `超过最大步数 ${this.maxSteps}` })
      return { status: 'failed' }
    }

    let streamed = false
    const onDelta = (t) => {
      streamed = true
      this.rc.emitTo(runId, 'text.delta', { text: t })
    }
    // run 级超时 + 用户取消：共用一个 AbortController，靠 reason 区分
    const entry = this.aborts.get(runId) ?? { ctrl: new AbortController(), reason: null }
    this.aborts.set(runId, entry)
    const timer = setTimeout(() => { entry.reason = 'timeout'; entry.ctrl.abort() }, this.timeoutMs)
    let decision
    try {
      decision = await this.driver.complete({ messages, tools: this.tools.schema, onDelta, signal: entry.ctrl.signal })
    } catch (e) {
      if (entry.reason === 'user') return { status: 'canceled' } // cancel() 已发过事件
      const timedOut = entry.reason === 'timeout' || entry.ctrl.signal.aborted
      this.rc.transition(runId, 'failed')
      this.rc.emitTo(runId, 'run.failed', {
        runId,
        error: timedOut ? `timeout after ${this.timeoutMs}ms` : String(e.message ?? e),
      })
      return { status: 'failed' }
    } finally {
      clearTimeout(timer)
    }

    if (decision.type === 'final') {
      if (decision.text) {
        // 流式时增量已逐块发过，这里不再整段重复
        if (!streamed) this.rc.emitTo(runId, 'text.delta', { text: decision.text })
        // 落库，刷新页面后历史仍在（用户故事 4：关页重开历史完整）
        this.store?.({ tenantId, sessionId, runId, role: 'assistant', content: decision.text })
      }
      this.rc.transition(runId, 'done')
      this.rc.emitTo(runId, 'run.finished', { runId, ok: true })
      return { status: 'done' }
    }

    const call = decision.call
    const callId = call.id || `call_${steps}`
    this.rc.emitTo(runId, 'tool.started', { tool: call.name, callId })

    const policy = this.tools.policy[call.name] ?? 'deny'
    // 会话级授权命中：不再弹卡，但留下 auto_approved 事件，保证可审计
    if (policy === 'confirm' && this.grants?.has({ tenantId, sessionId, tool: call.name })) {
      this.audit?.({ runId, tenantId, sessionId, tool: call.name, decision: 'session_grant' })
      this.rc.emitTo(runId, 'approval.auto_approved', {
        callId,
        tool: call.name,
        reason: 'session_grant',
        sessionId,
      })
      return this.executeAndContinue({ runId, messages, call, callId, steps, tenantId, sessionId })
    }

    if (policy === 'deny') {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: 'denied_by_policy' })
      messages.push({ role: 'tool', tool_call_id: callId, content: 'denied_by_policy' })
      return this.step({ runId, messages, steps: steps + 1, tenantId, sessionId })
    }
    if (policy === 'confirm') {
      const snapshot = { messages, call, callId, steps, tenantId, sessionId }
      this.pending.set(runId, snapshot)
      // 落库：进程重启后仍能恢复这次审批（内存态不可跨进程）
      this.pendingStore?.save({ runId, ...snapshot })
      this.rc.transition(runId, 'waiting_approval')
      this.rc.emitTo(runId, 'approval.requested', {
        callId,
        action: call.name,
        target: resolveTarget(call),
        impact: '写入会话工作区文件（可撤销：删除该文件）',
        args: call.args,
      })
      return { status: 'waiting_approval' }
    }

    return this.executeAndContinue({ runId, messages, call, callId, steps, tenantId, sessionId })
  }

  async executeAndContinue({ runId, messages, call, callId, steps, tenantId, sessionId }) {
    // 幂等：同一 (runId, callId) 只真正执行一次。审批/重试/崩溃恢复都可能再次走到这里。
    const cached = this.toolResults?.get(runId, callId)
    if (cached) {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: !!cached.ok, replayed: true, error: cached.error ?? undefined })
      messages.push({ role: 'tool', tool_call_id: callId, content: cached.content })
      return this.step({ runId, messages, steps: steps + 1, tenantId, sessionId })
    }
    try {
      const out = await this.tools.run(call.name, call.args, runId)
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: true, truncated: false })
      if (out.artifact) this.rc.emitTo(runId, 'artifact.created', out.artifact)
      messages.push({ role: 'tool', tool_call_id: callId, content: out.content })
      this.toolResults?.put({ runId, callId, ok: 1, content: out.content, artifact: out.artifact ?? null, error: null })
    } catch (e) {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: String(e.message) })
      messages.push({ role: 'tool', tool_call_id: callId, content: `error: ${e.message}` })
      this.toolResults?.put({ runId, callId, ok: 0, content: `error: ${e.message}`, artifact: null, error: String(e.message) })
    }
    return this.step({ runId, messages, steps: steps + 1, tenantId, sessionId })
  }

  // 用户取消：中止在途请求（信号一路传到 fetch），状态切 canceled 并发事件
  cancel(runId) {
    const status = this.rc.status(runId)
    if (!status) return { status: null, note: 'unknown_run' }
    if (TERMINAL.has(status)) return { status, note: 'already_terminal' }
    const entry = this.aborts.get(runId)
    if (entry) {
      entry.reason = 'user'
      entry.ctrl.abort()
    }
    this.rc.transition(runId, 'canceled')
    this.rc.emitTo(runId, 'run.canceled', { runId })
    this.pending.delete(runId)
    this.pendingStore?.clear(runId)
    return { status: 'canceled' }
  }

  async resume({ runId, decision }) {
    const status = this.rc.status(runId)
    if (status && TERMINAL.has(status)) {
      // 已经结束的 run 不该再被"批准"：顺手清掉可能残留的快照
      this.pending.delete(runId)
      this.pendingStore?.clear(runId)
      return { status, note: 'already_terminal' }
    }
    const p = this.pending.get(runId) ?? this.pendingStore?.load(runId) ?? null
    if (!p) return { status, note: 'no_pending_approval' }
    this.rc.emitTo(runId, 'approval.decided', { callId: p.callId, decision })
    this.pending.delete(runId)
    this.pendingStore?.clear(runId)

    if (decision === 'deny') {
      this.rc.transition(runId, 'canceled')
      this.rc.emitTo(runId, 'run.canceled', { runId })
      return { status: 'canceled' }
    }

    if (decision === 'allow_session' && this.grants) {
      this.grants.add({ tenantId: p.tenantId, sessionId: p.sessionId, tool: p.call.name })
    }

    this.rc.transition(runId, 'running')
    return this.executeAndContinue({
      runId,
      messages: p.messages,
      call: p.call,
      callId: p.callId,
      steps: p.steps,
      tenantId: p.tenantId,
      sessionId: p.sessionId,
    })
  }
}

function resolveTarget(call) {
  return `/data/tenants/<t>/workspace/<${'runId'}>/${call.args?.path ?? ''}`
}
