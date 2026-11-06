#!/usr/bin/env bash
# ③ 的前置条件检查：域名必须先被 Cloudflare 代理（橙云），否则 Access / 边缘限流都无从谈起。
# 用法：HOST=cto.ila3.top scripts/check-cf-proxy.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HOST="${HOST:-cto.ila3.top}"
pass=0; fail=0; skip=0
ok(){ printf '  ✔ %-32s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-32s %s\n' "$1" "$2"; fail=$((fail+1)); }
sk(){ printf '  ○ %-32s %s\n' "$1" "$2"; skip=$((skip+1)); }

echo "== 1) DNS 是否指向 Cloudflare 边缘"
ips=$(dig +short "$HOST" 2>/dev/null | grep -E '^[0-9.]+$' | head -4)
if [ -z "$ips" ]; then
  sk "DNS" "查询失败（网络/DNS 不可用）"
else
  cf=0; for ip in $ips; do case "$ip" in 104.2[0-9].*|172.6[0-9].*|172.7[0-9].*|104.1[6-9].*|162.15[0-9].*) cf=$((cf+1));; esac; done
  if [ "$cf" -gt 0 ]; then ok "DNS 指向 Cloudflare" "$(echo $ips | tr '\n' ' ')"; else no "DNS 指向 Cloudflare" "$(echo $ips | tr '\n' ' ')（不是橙云段）"; fi
fi

echo "== 2) 响应是否来自 Cloudflare 边缘"
hdr=$(timeout 15 curl -s -D - -o /dev/null "https://$HOST/healthz" 2>/dev/null)
if [ -z "$hdr" ]; then
  sk "边缘响应头" "链路不可达（未验证）"
else
  printf '%s' "$hdr" | grep -qi '^cf-ray:' && ok "cf-ray 存在" "$(printf '%s' "$hdr" | grep -i '^cf-ray:' | head -1 | cut -c1-40)" || no "cf-ray 存在" "缺失（可能未走 CF）"
  printf '%s' "$hdr" | grep -qiE '^server: *cloudflare' && ok "server: cloudflare" "" || no "server: cloudflare" "缺失"
fi

echo "== 3) 应用侧按真实客户端 IP 分桶的前提（单元已验，这里说明关系）"
echo "     CF 会加 CF-Connecting-IP；cloudflared→应用是回环；应用只信受信代理的转发头"
echo "     → 见 impl/test/hardening.test.mjs（伪造头在直连时被忽略）"

echo "== 汇总：pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ] || exit 1
