// 最小 service 桩：只为满足真实插件的 inject 依赖，让它们能被激活。
// 注意：这是诊断用的桩，不是产品实现；方法被调用时会抛错，避免"看起来能用"。
const NOT_IMPL = (svc, method) => () => {
  throw new Error(`stub service '${svc}.${method}' not implemented`)
}

function makeProxy(svc, impl = {}) {
  const known = new Set(Object.keys(impl))
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return NOT_IMPL(svc, String(prop))
    },
    has: () => true,
  })
}

export const name = 'stub-services'
export const inject = []

export function apply(ctx) {
  // dsh-tool-schedule.apply() 内部 ctx.inject(["schedule"]) 需要的服务
  const dispose = ctx.provide(
    'schedule',
    makeProxy('schedule', {
      list: () => [],
      create: () => { throw new Error('stub service schedule.create not implemented') },
    }),
  )
  ctx.effect(() => dispose)
}
