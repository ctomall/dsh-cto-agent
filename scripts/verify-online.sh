#!/usr/bin/env bash
# 线上验收：先等就绪，再逐项断言。避免"重启窗口"被误记成故障。
# 用法：APP_PASSWORD_FILE=.runtime-app-password scripts/verify-online.sh [https://cto.ila3.top]
set -uo pipefail
BASE="${1:-https://cto.ila3.top}"
. scripts/lib-login.sh
PW_FILE="${APP_PASSWORD_FILE:-.runtime-app-password}"
pass=0; fail=0; skip=0
ok() { printf '  ✔ %-42s %s\n' "$1" "$2"; pass=$((pass+1)); }
no() { printf '  ✖ %-42s %s\n' "$1" "$2"; fail=$((fail+1)); }
# 链路不通 != 产品有问题：如实记 SKIP，别把它算成失败（否则公网红灯没有信息量）
sk() { printf '  ○ %-42s %s\n' "$1" "$2"; skip=$((skip+1)); }
code() {
  # 公网入口有损（实测约 1/3 失败）：000 必须多试几次，否则"网络抖动"会被误报成"鉴权错了"
  local c i
  for i in 1 2 3 4; do
    c=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$@") || c="000"
    [ "$c" != "000" ] && { printf '%s' "$c"; return; }
    sleep 2
  done
  printf '000'
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
c_home=$(code "$BASE/"); [ "$c_home" = "302" ] && ok "未登录首页" "302" || { [ "$c_home" = "000" ] && sk "未登录首页" "链路不可达（未验证）" || no "未登录首页" "期望 302，实际 $c_home"; }
c_login=$(code "$BASE/login"); [ "$c_login" = "200" ] && ok "登录页" "200" || { [ "$c_login" = "000" ] && sk "登录页" "链路不可达（未验证）" || no "登录页" "期望 200，实际 $c_login"; }
c_api=$(code "$BASE/api/sessions"); [ "$c_api" = "401" ] && ok "未登录 API" "401" || { [ "$c_api" = "000" ] && sk "未登录 API" "链路不可达（未验证）" || no "未登录 API" "期望 401，实际 $c_api"; }

echo "== 3) 登录后放行"
# 口令来源：环境变量 PW > $APP_PASSWORD_FILE（默认 .runtime-app-password）
PW="${PW:-$(cut -d= -f2- "$PW_FILE" 2>/dev/null)}"
if [ -n "${PW:-}" ]; then
  jar=$(mktemp)
  lc=$(require_login "$BASE" "$jar" "$PW") || lc="000"
  [ "$lc" = "302" ] && ok "登录提交" "302" || no "登录提交" "期望 302，实际 $lc"
  pc=$(code2 -b "$jar" "$BASE/")
  [ "$pc" = "200" ] && ok "带 Cookie 首页" "200" || no "带 Cookie 首页" "期望 200，实际 $pc（隧道慢时可能 000）"
  # token 来源：环境变量 TOK_A > .runtime-tokens
  T_A="${TOK_A:-$(cut -d= -f2- .runtime-tokens 2>/dev/null | head -1)}"
  if [ -n "${T_A:-}" ]; then
    # 同样的有损链路问题：JSON 断言也要重试，否则一次超时会被当成"接口坏了"
    ms=""
    for i in 1 2 3 4; do
      ms=$(curl -s -b "$jar" -H "Authorization: Bearer $T_A" -m 15 "$BASE/api/model/status")
      echo "$ms" | grep -q '"driver"' && break
      sleep 2
    done
    echo "$ms" | grep -q '"driver"' && ok "model/status" "$(echo "$ms" | head -c 80)" || no "model/status" "${ms:-（4 次均超时，链路不可达）}"
  fi
  rm -f "$jar"
else
  no "登录后放行" "缺少口令（设置 PW 环境变量或 $PW_FILE）"
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
echo "== 结果：pass=$pass fail=$fail skip=$skip"
[ "$skip" -gt 0 ] && echo "注意：$skip 项因公网链路不可达而未验证（不计失败，也不算通过）"
[ "$fail" -eq 0 ]
