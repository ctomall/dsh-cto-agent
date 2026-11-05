// Agent loop：事件序列由模型决策驱动，审批处真正挂起，恢复后继续同一上下文。
export class AgentLoop {
  constructor({ rc, tools, driver, workspaceRoot, grants = null, audit = null, store = null, loadHistory = null, historyLimit = 20, maxSteps = 10 }) {
    this.rc = rc
    this.tools = tools
    this.driver = driver
    this.workspaceRoot = workspaceRoot
    this.grants = grants
    this.audit = audit
    this.store = store
    this.loadHistory = loadHistory
    this.historyLimit = historyLimit
    this.maxSteps = maxSteps
    this.pending = new Map() // runId -> { messages, call, callId, tenantId, sessionId }
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
    const decision = await this.driver.complete({ messages, tools: this.tools.schema, onDelta })

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
      this.pending.set(runId, { messages, call, callId, steps, tenantId, sessionId })
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
    try {
      const out = await this.tools.run(call.name, call.args, runId)
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: true, truncated: false })
      if (out.artifact) this.rc.emitTo(runId, 'artifact.created', out.artifact)
      messages.push({ role: 'tool', tool_call_id: callId, content: out.content })
    } catch (e) {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: String(e.message) })
      messages.push({ role: 'tool', tool_call_id: callId, content: `error: ${e.message}` })
    }
    return this.step({ runId, messages, steps: steps + 1, tenantId, sessionId })
  }

  async resume({ runId, decision }) {
    const p = this.pending.get(runId)
    if (!p) return { status: this.rc.status(runId), note: 'no_pending_approval' }
    this.rc.emitTo(runId, 'approval.decided', { callId: p.callId, decision })
    this.pending.delete(runId)

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
