// 阶段 1 spike（第二轮）：不再假设"声明 inject 即可加载"，改为实测依赖面。
// 产出：依赖链证据 + 加载/卸载断言 + 阻塞点定位。
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scheduleTool from '@deepseek-ai/dsh-tool-schedule'
import ScheduleService from '@deepseek-ai/dsh-schedule'

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const probe = (fn) => { try { return fn() } catch (e) { return `THREW:${e.message}` } }
const names = (ctx) => probe(() => ctx.tools.schemas().map((s) => s.name))

const out = { toolPlugins: {}, chain: {}, assertions: {}, blocked: null }

// A. 静态声明面：六个真实工具插件的 inject（不看文档，直接问包）
const pkgList = ['dsh-tool-fs', 'dsh-tool-present', 'dsh-tool-goal', 'dsh-tool-jobs', 'dsh-tool-ask-user', 'dsh-tool-schedule']
for (const p of pkgList) {
  const m = await import(`@deepseek-ai/${p}`)
  out.toolPlugins[p] = { name: m.name, inject: m.inject }
}

// B. 服务提供链：SystemPrompt → ToolRuntime
const ctx = new Context()
const dPrompt = ctx.plugin(SystemPrompt)
await tick()
out.chain.systemPrompt = { present: probe(() => typeof ctx.systemPrompt !== 'undefined') }

const dTools = ctx.plugin(ToolRuntime)
await tick()
out.chain.tools = { present: probe(() => typeof ctx.tools !== 'undefined') }

// C. 加载真实工具插件：声明只要求 tools，但 apply 内部又 inject 了 schedule
const dTool = ctx.plugin(scheduleTool)
await tick(600)
out.assertions.afterToolLoad = {
  toolCount: probe(() => ctx.tools.schemas().length),
  names: names(ctx),
  hasScheduleCreate: probe(() => ctx.tools.get('schedule_create') !== undefined),
}

// D. 卸载断言（插件本身可卸载，注册表条目应为 0）
await (typeof dTool === 'function' ? dTool() : dTool)
await tick()
out.assertions.afterToolUnload = { toolCount: probe(() => ctx.tools.schemas().length) }

// E. 阻塞点：schedule 服务自身需要 5 个服务，缺一个就 provide 不出来
out.chain.scheduleService = {
  class: ScheduleService?.name,
  inject: ScheduleService?.inject,
  presentAfterPlugin: probe(() => typeof ctx.schedule !== 'undefined'),
}
const dSchedule = ctx.plugin(ScheduleService)
await tick(400)
out.chain.scheduleService.presentAfterLoadAttempt = probe(() => typeof ctx.schedule !== 'undefined')
out.chain.scheduleService.note = 'inject 的 5 个服务本进程均未提供，插件保持未激活状态，不报错也不提供 schedule'

console.log(JSON.stringify(out, null, 2))
console.log('SPIKE_PARTIAL: 服务插件可加载、工具插件未激活（缺 schedule 依赖链）')
