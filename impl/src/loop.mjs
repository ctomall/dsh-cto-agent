// Agent loop：事件序列由模型决策驱动，审批处真正挂起，恢复后继续同一上下文。
export class AgentLoop {
  constructor({ rc, tools, driver, workspaceRoot, maxSteps = 10 }) {
    this.rc = rc
    this.tools = tools
    this.driver = driver
    this.workspaceRoot = workspaceRoot
    this.maxSteps = maxSteps
    this.pending = new Map() // runId -> { messages, call, callId }
  }

  async start({ runId, input }) {
    this.rc.create(runId)
    this.rc.transition(runId, 'running')
    this.rc.emitTo(runId, 'text.delta', { text: `收到目标：${input}` })
    const messages = [{ role: 'user', content: input }]
    return this.step({ runId, messages, steps: 0 })
  }

  async step({ runId, messages, steps }) {
    if (steps >= this.maxSteps) {
      this.rc.transition(runId, 'failed')
      this.rc.emitTo(runId, 'run.failed', { runId, error: `超过最大步数 ${this.maxSteps}` })
      return { status: 'failed' }
    }

    const decision = await this.driver.complete({ messages, tools: this.tools.schema })

    if (decision.type === 'final') {
      if (decision.text) this.rc.emitTo(runId, 'text.delta', { text: decision.text })
      this.rc.transition(runId, 'done')
      this.rc.emitTo(runId, 'run.finished', { runId, ok: true })
      return { status: 'done' }
    }

    const call = decision.call
    const callId = call.id || `call_${steps}`
    this.rc.emitTo(runId, 'tool.started', { tool: call.name, callId })

    const policy = this.tools.policy[call.name] ?? 'deny'
    if (policy === 'deny') {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: 'denied_by_policy' })
      messages.push({ role: 'tool', tool_call_id: callId, content: 'denied_by_policy' })
      return this.step({ runId, messages, steps: steps + 1 })
    }
    if (policy === 'confirm') {
      this.pending.set(runId, { messages, call, callId, steps })
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

    return this.executeAndContinue({ runId, messages, call, callId, steps })
  }

  async executeAndContinue({ runId, messages, call, callId, steps }) {
    try {
      const out = await this.tools.run(call.name, call.args, runId)
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: true, truncated: false })
      if (out.artifact) this.rc.emitTo(runId, 'artifact.created', out.artifact)
      messages.push({ role: 'tool', tool_call_id: callId, content: out.content })
    } catch (e) {
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: String(e.message) })
      messages.push({ role: 'tool', tool_call_id: callId, content: `error: ${e.message}` })
    }
    return this.step({ runId, messages, steps: steps + 1 })
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

    this.rc.transition(runId, 'running')
    return this.executeAndContinue({ runId, messages: p.messages, call: p.call, callId: p.callId, steps: p.steps })
  }
}

function resolveTarget(call) {
  return `/data/tenants/<t>/workspace/<${'runId'}>/${call.args?.path ?? ''}`
}
