// 应用层限流：滑动窗口，按 (clientIp, bucket) 计数。
// 为什么必须在应用层做：Cloudflare 侧规则需要 API 凭据，且隧道后面的运维接口更该自己守。
export function createRateLimiter({ clock = () => Date.now(), maxKeys = 10_000 } = {}) {
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
      // 键数量上限：伪造来源 IP 会不断产生新键，不做上限就是内存 DoS 入口
      if (buckets.size > maxKeys) {
        for (const [k, v] of buckets) {
          const alive = v.some((t) => now - t < 60_000)
          if (!alive) buckets.delete(k)
          if (buckets.size <= maxKeys) break
        }
        // 仍然超限：按插入顺序淘汰最老的键
        while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value)
      }
      return { ok: true, remaining: limit - live.length }
    },
    reset() {
      buckets.clear()
    },
    get size() {
      return buckets.size
    },
  }
}

// 限流阈值可按环境变量调整：高吞吐部署不该为此改代码
const num = (envKey, fallback) => {
  const v = Number(process.env[envKey])
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback
}

export const LIMITS = {
  api: { limit: num('RATE_API_LIMIT', 60), windowMs: 60_000 },
  runs: { limit: num('RATE_RUNS_LIMIT', 20), windowMs: 60_000 },
  upgrade: { limit: num('RATE_UPGRADE_LIMIT', 3), windowMs: 60_000 },
  login: { limit: num('RATE_LOGIN_LIMIT', 5), windowMs: 60_000 },
}

export function bucketFor(pathname, method) {
  if (pathname === '/api/admin/upgrade') return 'upgrade'
  if (pathname === '/login' && method === 'POST') return 'login'
  if (pathname === '/api/runs' && method === 'POST') return 'runs'
  if (pathname.startsWith('/api/')) return 'api'
  return null
}

// 转发头只在"连接来自受信代理"时才可信：cloudflared 从回环连入；
// 直连（非回环）时若还信 x-forwarded-for，伪造一个头就能绕过限流。
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function clientIp(req, { trustProxy = isTrustedProxy(req.socket?.remoteAddress) } = {}) {
  if (trustProxy) {
    const forwarded = req.headers?.['cf-connecting-ip'] || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return req.socket?.remoteAddress || 'unknown'
}

export function isTrustedProxy(remote) {
  if (!remote) return false
  if (LOOPBACK.has(remote)) return true
  const extra = (process.env.TRUSTED_PROXIES ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return extra.includes(remote)
}
