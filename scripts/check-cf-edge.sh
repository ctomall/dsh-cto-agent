#!/usr/bin/env bash
# ③ 的边缘验收（需要 Cloudflare 凭据）。**注意：本脚本尚未用真实凭据运行过**——
# 它的断言依据是 Cloudflare 公开 API 与边缘行为，首次执行时请人工核对每一行。
# 用法：CLOUDFLARE_API_TOKEN=… CF_ACCOUNT_ID=… CF_ZONE_ID=… ./scripts/check-cf-edge.sh [HOST]
set -uo pipefail
HOST="${1:-cto.ila3.top}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"   # 可用 CF_API_BASE 指向本地 mock 自测
TOKEN="${CLOUDFLARE_API_TOKEN:-}"; ACC="${CF_ACCOUNT_ID:-}"; ZONE="${CF_ZONE_ID:-}"
pass=0; fail=0; skip=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }
sk(){ printf '  ○ %-30s %s\n' "$1" "$2"; skip=$((skip+1)); }

# EDGE_ONLY=1：只验边缘行为（不需要凭据），用于"现在没有 Access"时确认检测逻辑有效
EDGE_ONLY="${EDGE_ONLY:-0}"
if [ "$EDGE_ONLY" != "1" ] && { [ -z "$TOKEN" ] || [ -z "$ACC" ] || [ -z "$ZONE" ]; }; then
  sk "Cloudflare 凭据" "未配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID"
  echo; echo "== 结果：pass=0 fail=0 skip=1"
  exit 0
fi
hdr=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

if [ "$EDGE_ONLY" != "1" ]; then
echo "== 1) Access 应用（self_hosted，覆盖 $HOST）"
apps=$(curl -sS -m 20 "${hdr[@]}" "$API/accounts/$ACC/access/apps")
app=$(printf '%s' "$apps" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except: d={}
host=sys.argv[1]
for a in (d.get("result") or []):
    if a.get("domain")==host: print(json.dumps(a)); break
' "$HOST")
if [ -n "$app" ]; then
  ok "Access 应用存在" "$HOST"
  app_id=$(printf '%s' "$app" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
  pol=$(curl -sS -m 20 "${hdr[@]}" "$API/accounts/$ACC/access/apps/$app_id/policies")
  echo "$pol" | grep -q '"decision": *"allow"' && ok "策略为 allow" "存在 allow 策略" || no "策略为 allow" "$(echo "$pol" | head -c 120)"
  echo "$pol" | grep -q '"email"' && ok "按邮箱白名单" "包含 email 条件" || no "按邮箱白名单" "未见 email 条件"
else
  no "Access 应用存在" "未找到 domain=$HOST 的应用"
fi

echo "== 2) 边缘限流规则"
rs=$(curl -sS -m 20 "${hdr[@]}" "$API/zones/$ZONE/rulesets/phases/http_ratelimit/entrypoint")
echo "$rs" | grep -q '"rules"' && ok "限流规则集" "已配置" || no "限流规则集" "$(echo "$rs" | head -c 140)"
echo "$rs" | grep -q "$HOST" && ok "限流命中该域名" "$HOST" || no "限流命中该域名" "表达式里没有 $HOST"

fi

if [ "${CF_API_ONLY:-0}" = "1" ]; then
  echo "== 结果：pass=$pass fail=$fail skip=$skip（CF_API_ONLY=1，未跑边缘行为探测）"
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

echo "== 3) 边缘行为：未授权必须被挡在 Cloudflare（而不是落到应用的 /login）"
# 公网链路会丢包：每个探测重试 3 次，避免把 000 当成"应用层放行"
fetch_headers() {
  local url="$1" i out
  for i in 1 2 3; do
    out=$(curl -sS -o /dev/null -D - -m 25 "$url" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    sleep 2
  done
  return 1
}
code_retry() {
  local url="$1" i c
  for i in 1 2 3; do
    c=$(curl -sS -o /dev/null -w '%{http_code}' -m 25 "$url" 2>/dev/null) || c="000"
    [ "$c" != "000" ] && { printf '%s' "$c"; return 0; }
    sleep 2
  done
  printf '%s' "$c"
}
if ! h=$(fetch_headers "https://$HOST/"); then
  sk "未授权跳转" "公网不可达（3 次重试仍失败）"
  h=""
fi
loc=$(printf '%s' "$h" | grep -i '^location:' | head -1)
if [ -z "$h" ]; then
  :
elif printf '%s' "$h" | grep -qi 'cloudflareaccess.com'; then
  ok "未授权跳转" "被 Access 拦截（cloudflareaccess.com）"
elif printf '%s' "$h" | grep -qi '^HTTP/[0-9.]* 403'; then
  ok "未授权跳转" "边缘 403"
else
  no "未授权跳转" "看起来落在了应用层：${loc:-无 location}"
fi
u=$(code_retry "https://$HOST/api/admin/upgrade")
case "$u" in 403|302) ok "升级接口在边缘被拒" "$u" ;; 000) sk "升级接口在边缘被拒" "公网不可达" ;; *) no "升级接口在边缘被拒" "期望 403/302，实际 $u" ;; esac

echo
echo "== 结果：pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ] || exit 1
