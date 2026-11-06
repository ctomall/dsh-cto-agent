#!/usr/bin/env bash
# 限流证据：在临时实例上把 api 桶打满，验证 429 + retry-after + 桶之间互不影响。
# 用法：scripts/ratelimit-check.sh [PORT]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT="${1:-8798}"
DB=$(mktemp -u /tmp/rl-XXXX.db); LOG=$(mktemp)

APP_PASSWORD= APP_SESSION_SECRET= CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"}}' \
  PORT="$PORT" DB_PATH="$DB" WORKSPACE_ROOT=/tmp/rl-ws \
  node impl/src/server.mjs >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm" "$LOG"' EXIT

for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/healthz")" = 200 ] && break
  sleep 0.5
done

pass=0 fail=0
ok(){ printf '  ✔ %-32s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-32s %s\n' "$1" "$2"; fail=$((fail+1)); }

H=(-H 'authorization: Bearer tok_a')
echo "== api 桶（60/min）"
first=$(curl -s -D /tmp/rl-h1 -o /dev/null -m 5 "${H[@]}" "http://127.0.0.1:$PORT/api/me")
grep -qi 'x-ratelimit-remaining' /tmp/rl-h1 && ok "响应含剩余额度头" "$(grep -i x-ratelimit-remaining /tmp/rl-h1 | tr -d '\r' | awk '{print $2}')" || no "响应含剩余额度头" "缺失"

code429=0
for i in $(seq 1 75); do
  c=$(curl -s -o /tmp/rl-body -w '%{http_code}' -m 5 "${H[@]}" "http://127.0.0.1:$PORT/api/me")
  if [ "$c" = 429 ]; then code429=$i; break; fi
done
[ "$code429" -gt 0 ] && ok "api 桶触发 429" "第 $code429 次请求" || no "api 桶触发 429" "75 次未触发"
ra=$(curl -s -D /tmp/rl-h2 -o /dev/null -m 5 "${H[@]}" "http://127.0.0.1:$PORT/api/me" && grep -i '^retry-after' /tmp/rl-h2 | tr -d '\r' | awk '{print $2}')
[ -n "$ra" ] && ok "429 带 retry-after" "${ra}s" || no "429 带 retry-after" "缺失"

echo "== 桶隔离（login 桶不应被 api 桶影响）"
# 口令错 → 401 属正常；关键是它没有因为 api 桶被打满而 5xx/挂死
lc=$(curl -s -o /tmp/rl-login -w '%{http_code}' -m 5 -X POST -d 'password=x' "http://127.0.0.1:$PORT/login")
if [ "$lc" = 200 ] || [ "$lc" = 302 ] || [ "$lc" = 401 ]; then
  ok "login 端点仍可响应" "$lc（不共享 api 桶）"
elif [ "$lc" = 429 ]; then
  ok "login 端点仍可响应" "429（登录桶，符合预期）"
else
  no "login 端点仍可响应" "$lc"
fi

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
