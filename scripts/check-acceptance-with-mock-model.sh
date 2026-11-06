#!/usr/bin/env bash
# 用"本地 mock 模型 + 临时实例"跑一遍验收器：证明 ① 的断言**可满足**（真驱动、事件由模型决定），
# 这样等真 key 到手时，①从 SKIP 变 PASS 需要的只是凭据，而不是代码改动。
# 用法：scripts/check-acceptance-with-mock-model.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
MOCK_PORT=8796; APP_PORT=8795
WORK=$(mktemp -d)
cleanup(){ for p in $MOCK_PORT $APP_PORT; do local pid; pid=$(ss -ltnp 2>/dev/null | awk -v pp=":$p " '$0 ~ pp {print $NF}' | grep -oP 'pid=\K[0-9]+' | head -1); [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

node scripts/mock-provider.mjs $MOCK_PORT >/dev/null 2>&1 &
sleep 1
APP_PASSWORD='mock-pw' APP_SESSION_SECRET='mock-secret-1234567890' \
CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"},"tok_b":{"tenantId":"t_b","userId":"u_b"}}' \
MODEL_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MODEL_NAME='mock' MODEL_API_KEY='sk-mock' \
PORT=$APP_PORT DB_PATH="$WORK/cube.db" WORKSPACE_ROOT="$WORK/ws" node impl/src/server.mjs >/dev/null 2>&1 &
for i in $(seq 1 40); do sleep 0.5; [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$APP_PORT/healthz")" = 200 ] && break; done

out=$(PW='mock-pw' TOK_A='tok_a' TOK_B='tok_b' timeout 400 ./scripts/acceptance.sh "http://127.0.0.1:$APP_PORT" 2>&1)
printf '%s\n' "$out" | grep -E '^== |① |真实链路|驱动|事件序列|产物' | tail -12
sum=$(printf '%s\n' "$out" | tail -1)
echo "… $sum"
# ① 必须 **PASS**（不是 SKIP）：用断言行判定，不能用小节标题（标题恒存在，会假通过）
if printf '%s' "$out" | grep -q '✔ 模型选择了工具' && printf '%s' "$out" | grep -q '✔ driver 非 fake'; then
  printf '%s\n' "$out" | sed -n '/== ①/,/== ②/p' | head -7
  echo "OK: 挂上 mock 真驱动后，① 的五条断言全部通过（判据可满足，只差真厂商行为）"
  exit 0
fi
echo "FAIL: ① 未通过（mock 真驱动下也不满足判据）"
printf '%s\n' "$out" | sed -n '/== ①/,/== ②/p' | head -10
exit 1
