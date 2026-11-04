// 应用层限流：滑动窗口，按 (clientIp, bucket) 计数。
// 为什么必须在应用层做：Cloudflare 侧规则需要 API 凭据，且隧道后面的运维接口更该自己守。
export function createRateLimiter({ clock = () => Date.now() } = {}) {
  const buckets = new Map()

  return {
    check(key, limit, windowMs) {
      const now = clock()
      const prev = buckets.get(key) ?? []
      const live = prev.filter((t) => now - t < windowMs)
      if (live.length >= limit) {
        buckets.set(key, live)
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now - live[0])) / 1000))
        return { ok: false, remaining: 0, retryAfter, limit }
      }
      live.push(now)
      buckets.set(key, live)
      return { ok: true, remaining: limit - live.length }
    },
    reset() {
      buckets.clear()
    },
  }
}

export const LIMITS = {
  api: { limit: 60, windowMs: 60_000 },
  runs: { limit: 20, windowMs: 60_000 },
  upgrade: { limit: 3, windowMs: 60_000 },
  login: { limit: 5, windowMs: 60_000 },
}

export function bucketFor(pathname, method) {
  if (pathname === '/api/admin/upgrade') return 'upgrade'
  if (pathname === '/login' && method === 'POST') return 'login'
  if (pathname === '/api/runs' && method === 'POST') return 'runs'
  if (pathname.startsWith('/api/')) return 'api'
  return null
}

export function clientIp(req) {
  return req.headers?.['cf-connecting-ip'] || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown'
}
