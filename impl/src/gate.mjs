// 应用层身份门：Cloudflare Access 需要账号级 API 凭据，没有凭据时不能靠它兜底。
// 这里用「口令 → HMAC Cookie」做最小身份层，未配置 APP_PASSWORD 时整体关闭（本地/测试不受影响）。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(String(a ?? '')).digest()
  const hb = createHash('sha256').update(String(b ?? '')).digest()
  return timingSafeEqual(ha, hb)
}

export function createGate({ password, secret } = {}) {
  if (!password) return null
  if (!secret) throw new Error('APP_SESSION_SECRET 必填：配置了 APP_PASSWORD 却没有签名密钥')

  const token = createHmac('sha256', secret).update('cube-agent-session').digest('hex')

  return {
    enabled: true,
    token,
    verify(cookieHeader) {
      const m = /(?:^|;\s*)cube_session=([^;]+)/.exec(cookieHeader ?? '')
      return !!m && safeEqual(m[1], token)
    },
    checkPassword(input) {
      return safeEqual(input, password)
    },
    // secure=true 时加 Secure（HTTPS 链路）：防止降级到 http 时仍被发送
    cookie({ secure = false } = {}) {
      return `cube_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`
    },
  }
}

export const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>cube-agent · 登录</title>
<style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#F7F7F8;color:#17171A;
font:400 14px/22px -apple-system,"PingFang SC","WenQuanYi Zen Hei",system-ui,sans-serif}
form{background:#fff;border:1px solid #E6E6EA;border-radius:12px;padding:28px 26px;width:320px}
h1{font:600 18px/26px inherit;margin:0 0 6px}p{color:#5C5C66;margin:0 0 18px;font-size:13px}
input{width:100%;box-sizing:border-box;border:1px solid #D3D3DA;border-radius:8px;padding:10px 12px;font:inherit;margin-bottom:12px}
input:focus{outline:none;border-color:#2F6BFF;box-shadow:0 0 0 3px #EAF0FF}
button{width:100%;background:#2F6BFF;color:#fff;border:1px solid #2F6BFF;border-radius:8px;padding:9px 14px;font:500 14px/20px inherit;cursor:pointer}
.err{color:#C4321F;font-size:12px;margin:0 0 10px}
</style></head><body>
<form method="post" action="/login">
  <h1>cube-agent</h1>
  <p>输入访问口令以继续</p>
  <!--ERR-->
  <input name="password" type="password" autocomplete="current-password" placeholder="访问口令" autofocus />
  <button type="submit">进入</button>
</form></body></html>`
