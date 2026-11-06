// Agent loop：事件序列由模型决策驱动，审批处真正挂起，恢复后继续同一上下文。
import { TERMINAL } from './runs.mjs'

// 审批事件里只放"给人看的摘要"：真实模型可能一次写几十 KB，
// 整段塞进事件会同时污染数据库、事件流和审批卡（执行用的仍是内存里的完整参数）。
function trimArgsForEvent(args, limit = 512) {
  let truncated = false
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length > limit) { truncated = true; return `${v.slice(0, limit)}…（共 ${v.length} 字，已截断）` }
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    return v
  }
  return { args: walk(args), truncated }
}
export class AgentLoop {
  constructor({ rc, tools, driver, workspaceRoot, grants = null, audit = null, store = null, loadHistory = null, historyLimit = 20, maxSteps = 10, timeoutMs = 120_000, pendingStore = null, toolResults = null, onUsage = null }) {
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
    this.onUsage = onUsage
    this.usage = null
    this.pending = new Map() // runId -> { messages, call, callId, tenantId, sessionId }
    this.aborts = new Map() // runId -> { ctrl, reason }  （用户取消 / 超时共用）
  }

  async start({ runId, tenantId = null, sessionId = null, input }) {
    this.reasoningTotal = 0
    this.rc.create(runId, { tenantId, sessionId, driver: this.driver?.name ?? null })
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
      if (decision?.usage) {
        this.usage = this.usage ?? {}
        for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          const v = Number(decision.usage[k])
          if (Number.isFinite(v)) this.usage[k] = (this.usage[k] ?? 0) + v
        }
        this.onUsage?.(decision.usage)
      }
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
      // 模型因长度上限被截断时，产物可能是半截的：必须显式告诉用户，不能静默当成功
      const truncated = decision.finishReason === 'length'
      if (truncated) {
        this.rc.emitTo(runId, 'text.delta', { text: '\n\n（输出因长度上限被截断，可让它接着写）' })
      }
      this.rc.transition(runId, 'done')
      this.rc.emitTo(runId, 'run.finished', {
        runId,
        ok: true,
        // 模型最终文本长度（不含"收到目标"回显）：前端据此判断"这次有没有正文"
        textChars: String(decision.text ?? '').length,
        // 只输出思考时用于区分"思考了但没答案"与"什么都没输出"
        ...(this.reasoningTotal ? { reasoningChars: this.reasoningTotal } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(this.usage ? { usage: this.usage } : {}),
      })
      return { status: 'done' }
    }

    // 真实模型可能给出意料之外的形状（未知 type、缺 call、call.name 非字符串）：
    // 必须在 run 内干净失败，而不是把异常抛到调用方、把 run 挂在 running 上
    if (!decision || decision.type !== 'tool_call' || !decision.call || typeof decision.call.name !== 'string' || !decision.call.name) {
      this.rc.transition(runId, 'failed')
      this.rc.emitTo(runId, 'run.failed', {
        runId,
        error: `invalid_model_output: ${JSON.stringify(decision)?.slice(0, 160) ?? 'null'}`,
      })
      return { status: 'failed' }
    }

    // 并行 tool_call：只执行第一个，其余显式回报给模型（否则模型永远等不到结果）
    if (Array.isArray(decision.others) && decision.others.length) {
      for (const extra of decision.others) {
        const eid = extra?.id || `call_extra_${steps}_${extra?.name ?? 'unknown'}`
        this.rc.emitTo(runId, 'tool.finished', { callId: eid, ok: false, error: 'parallel_tool_calls_unsupported' })
        messages.push({ role: 'tool', tool_call_id: eid, content: 'parallel_tool_calls_unsupported: 一次只执行一个工具，请逐个调用' })
      }
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
      const trimmed = trimArgsForEvent(call.args)
      this.rc.emitTo(runId, 'approval.requested', {
        callId,
        action: call.name,
        target: resolveTarget(call),
        impact: '写入会话工作区文件（可撤销：删除该文件）',
        args: trimmed.args,
        ...(trimmed.truncated ? { argsTruncated: true } : {}),
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
      // 先落幂等缓存再发事件：事件一旦被看到，重放/崩溃恢复就必须能拿到同一结果
      this.toolResults?.put({ runId, callId, ok: 1, content: out.content, artifact: out.artifact ?? null, error: null })
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: true, truncated: false })
      if (out.artifact) this.rc.emitTo(runId, 'artifact.created', out.artifact)
      messages.push({ role: 'tool', tool_call_id: callId, content: out.content })
    } catch (e) {
      this.toolResults?.put({ runId, callId, ok: 0, content: `error: ${e.message}`, artifact: null, error: String(e.message) })
      this.rc.emitTo(runId, 'tool.finished', { callId, ok: false, error: String(e.message) })
      messages.push({ role: 'tool', tool_call_id: callId, content: `error: ${e.message}` })
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
    // 先落授权再发事件：事件到达前端时，/grants 必须已经是新状态
    // （否则前端在 approval.decided 里刷新授权面板会读到旧值，面板永远显示"尚未授权"）
    if (decision === 'allow_session' && this.grants) {
      this.grants.add({ tenantId: p.tenantId, sessionId: p.sessionId, tool: p.call.name })
    }
    this.rc.emitTo(runId, 'approval.decided', { callId: p.callId, decision })
    this.pending.delete(runId)
    this.pendingStore?.clear(runId)

    if (decision === 'deny') {
      this.rc.transition(runId, 'canceled')
      this.rc.emitTo(runId, 'run.canceled', { runId })
      return { status: 'canceled' }
    }

    // 竞态保护：判完终态到真正迁移之间，可能被 cancel 抢先改状态；
    // 这里不抛 500，而是返回 state_changed 让调用方按"已变化"处理
    try {
      this.rc.transition(runId, 'running')
    } catch (e) {
      return { status: this.rc.status(runId), note: 'state_changed', error: String(e.message ?? e) }
    }
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
