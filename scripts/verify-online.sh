#!/usr/bin/env bash
# 线上验收：先等就绪，再逐项断言。避免"重启窗口"被误记成故障。
# 用法：APP_PASSWORD_FILE=.runtime-app-password scripts/verify-online.sh [https://cto.ila3.top]
set -uo pipefail
BASE="${1:-https://cto.ila3.top}"
PW_FILE="${APP_PASSWORD_FILE:-.runtime-app-password}"
pass=0; fail=0
ok() { printf '  ✔ %-42s %s\n' "$1" "$2"; pass=$((pass+1)); }
no() { printf '  ✖ %-42s %s\n' "$1" "$2"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }

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
  lc=$(curl -s -o /dev/null -c "$jar" -w '%{http_code}' -m 15 -X POST -d "password=$PW" "$BASE/login")
  [ "$lc" = "302" ] && ok "登录提交" "302" || no "登录提交" "期望 302，实际 $lc"
  [ "$(code -b "$jar" "$BASE/")" = "200" ] && ok "带 Cookie 首页" "200" || no "带 Cookie 首页" "期望 200"
  T_A=$(cut -d= -f2- .runtime-tokens 2>/dev/null | head -1)
  if [ -n "${T_A:-}" ]; then
    ms=$(curl -s -b "$jar" -H "Authorization: Bearer $T_A" -m 15 "$BASE/api/model/status")
    echo "$ms" | grep -q '"driver"' && ok "model/status" "$(echo "$ms" | head -c 80)" || no "model/status" "$ms"
  fi
  rm -f "$jar"
else
  no "登录后放行" "缺少口令文件 $PW_FILE"
fi

echo
echo "== 结果：pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
