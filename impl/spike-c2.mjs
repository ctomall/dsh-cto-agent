// 阶段 1 spike（第三轮）：用最小 service 桩打通依赖链，验证 C2-a / C2-b。
// C2-a：服务插件加载后目标 service 可解析。
// C2-b：工具插件加载后 schemas() 非空，且能成功执行一次调用。
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolPlugin from '@deepseek-ai/dsh-tool-schedule'
import * as stubs from './services/stub-services.mjs'

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const probe = (fn) => { try { return fn() } catch (e) { return `THREW:${e.message}` } }
const toolNames = (ctx) => probe(() => ctx.tools.schemas().map((s) => s.name))

const out = { steps: {}, c2a: false, c2b: false, call: null }

const ctx = new Context()

// 1) 桩服务（提供 schedule）
const dStub = ctx.plugin(stubs)
await tick()
out.steps.stub = { schedulePresent: probe(() => typeof ctx.schedule !== 'undefined') }

// 2) 真实 systemPrompt 服务
const dPrompt = ctx.plugin(SystemPrompt)
await tick()
out.steps.systemPrompt = { present: probe(() => typeof ctx.systemPrompt !== 'undefined') }

// 3) 真实 tools 服务
const dTools = ctx.plugin(ToolRuntime)
await tick()
out.steps.tools = { present: probe(() => typeof ctx.tools !== 'undefined') }

// 4) 真实工具插件
const dTool = ctx.plugin(toolPlugin)
await tick(600)

const names = toolNames(ctx)
out.steps.loaded = {
  toolCount: Array.isArray(names) ? names.length : names,
  names: Array.isArray(names) ? names : [],
  hasScheduleCreate: probe(() => ctx.tools.get('schedule_create') !== undefined),
}

// C2-a：服务可解析
out.c2a = out.steps.systemPrompt.present === true && out.steps.tools.present === true

// C2-b：工具可注册
const registered = Array.isArray(names) && names.length > 0
out.c2b = out.c2b || registered

// 5) 尝试真正执行一次调用（C2-b 的严格口径）
if (registered) {
  const name = names.includes('schedule_list') ? 'schedule_list' : names[0]
  try {
    const res = await ctx.tools.execute({ callId: 'call_spike_1', name, arguments: {}, signal: new AbortController().signal })
    out.call = { tool: name, ok: true, result: JSON.stringify(res).slice(0, 400) }
  } catch (e) {
    out.call = { tool: name, ok: false, error: `${e.constructor.name}: ${e.message}`.slice(0, 400) }
  }
}

// 6) 卸载归零（此时非空才有意义）
const disposeOne = async (d) => {
  if (typeof d === 'function') { await d(); return 'fn' }
  if (d && typeof d.dispose === 'function') { await d.dispose(); return 'dispose()' }
  if (d && typeof d.then === 'function') { await d; return 'then' }
  return `noop:${typeof d}:${d && Object.keys(d).join('|')}`
}
out.disposeMode = await disposeOne(dTool)
await tick()
out.steps.afterUnload = { toolCount: probe(() => ctx.tools.schemas().length) }

await disposeOne(dStub)
await tick()

console.log(JSON.stringify(out, null, 2))
const verdict = out.c2a && registered && out.call?.ok === true && out.steps.afterUnload.toolCount === 0
console.log(verdict ? 'C2_PASS' : (out.c2a && registered ? 'C2B_REGISTERED_NOT_CALLED' : 'C2A_ONLY'))
if (!verdict) process.exitCode = 1
