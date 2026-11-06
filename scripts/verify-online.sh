#!/usr/bin/env bash
# 线上验收：先等就绪，再逐项断言。避免"重启窗口"被误记成故障。
# 用法：APP_PASSWORD_FILE=.runtime-app-password scripts/verify-online.sh [https://cto.ila3.top]
set -uo pipefail
BASE="${1:-https://cto.ila3.top}"
. scripts/lib-login.sh
PW_FILE="${APP_PASSWORD_FILE:-.runtime-app-password}"
pass=0; fail=0
ok() { printf '  ✔ %-42s %s\n' "$1" "$2"; pass=$((pass+1)); }
no() { printf '  ✖ %-42s %s\n' "$1" "$2"; fail=$((fail+1)); }
code() {
  local c
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$@") || c="000"
  if [ "$c" = "000" ]; then sleep 2; c=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$@") || c="000"; fi
  printf '%s' "$c"
}

code2() { # 慢链路用：45s 超时，000 时最多再试 2 次
  local c i
  for i in 1 2 3; do
    c=$(curl -s -o /dev/null -w '%{http_code}' -m 45 "$@") || c="000"
    # 000=网络抖动；502/503/504=升级重启窗口内 origin 未就绪（cloudflared 连不上）
    case "$c" in 000|502|503|504) : ;; *) printf '%s' "$c"; return 0 ;; esac
    sleep 3
  done
  printf '%s' "$c"
}

echo "== 1) 等待就绪（/healthz，最多 40s）"
ready=0
for i in $(seq 1 40); do
  if [ "$(code "$BASE/healthz")" = "200" ]; then ready=$i; break; fi
  sleep 1
done
[ "$ready" -gt 0 ] && ok "healthz 就绪" "第 ${ready}s" || { no "healthz 就绪" "40s 未就绪"; }

echo "== 2) 身份门"
[ "$(code "$BASE/")" = "302" ] && ok "未登录首页" "302" || no "未登录首页" "期望 302"
[ "$(code "$BASE/login")" = "200" ] && ok "登录页" "200" || no "登录页" "期望 200"
[ "$(code "$BASE/api/sessions")" = "401" ] && ok "未登录 API" "401" || no "未登录 API" "期望 401"

echo "== 3) 登录后放行"
if [ -f "$PW_FILE" ]; then
  PW=$(cut -d= -f2- "$PW_FILE")
  jar=$(mktemp)
  lc=$(require_login "$BASE" "$jar" "$PW") || lc="000"
  [ "$lc" = "302" ] && ok "登录提交" "302" || no "登录提交" "期望 302，实际 $lc"
  pc=$(code2 -b "$jar" "$BASE/")
  [ "$pc" = "200" ] && ok "带 Cookie 首页" "200" || no "带 Cookie 首页" "期望 200，实际 $pc（隧道慢时可能 000）"
  T_A=$(cut -d= -f2- .runtime-tokens 2>/dev/null | head -1)
  if [ -n "${T_A:-}" ]; then
    ms=$(curl -s -b "$jar" -H "Authorization: Bearer $T_A" -m 15 "$BASE/api/model/status")
    echo "$ms" | grep -q '"driver"' && ok "model/status" "$(echo "$ms" | head -c 80)" || no "model/status" "$ms"
  fi
  rm -f "$jar"
else
  no "登录后放行" "缺少口令文件 $PW_FILE"
fi

echo "== 4) 安全响应头（公网实际返回，不是本机）"
hdr=$(curl -s -D - -o /dev/null -m 25 "$BASE/login")
for want in "content-security-policy" "x-frame-options" "x-content-type-options" "referrer-policy"; do
  if printf '%s' "$hdr" | grep -qi "^$want:"; then ok "响应头 $want" "$(printf '%s' "$hdr" | grep -i "^$want:" | head -1 | cut -c1-60)"; else no "响应头 $want" "缺失"; fi
done

echo "== 5) 升级接口仅限授权主体（不带 token 必须 401）"
uc=$(code2 -X POST "$BASE/api/admin/upgrade")
[ "$uc" = "401" ] && ok "升级无 token" "401" || no "升级无 token" "期望 401，实际 $uc（000 为公网丢包）"

echo
echo "== 结果：pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
