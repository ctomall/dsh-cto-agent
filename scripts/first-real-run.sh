#!/usr/bin/env bash
# 真模型接入后的"第一次验收"：一条命令跑完 目标→工具→审批→产出，并打印证据。
# 用法：scripts/first-real-run.sh [BASE]      默认 http://127.0.0.1:8787
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:-http://127.0.0.1:8787}"
GOAL="${GOAL:-写一份验收报告到 real-run.md}"

PW="${PW:-$(cut -d= -f2- .runtime-app-password 2>/dev/null)}"
TOK_A="${TOK:-$(cut -d= -f2- .runtime-tokens 2>/dev/null | head -1)}"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT

ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; exit 1; }

echo "== 0) 就绪"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/healthz")" = 200 ] || no "healthz" "不可达：$BASE"
[ -n "$PW" ] && curl -s -o /dev/null -c "$JAR" -m 20 -X POST -d "password=$PW" "$BASE/login"

echo "== 1) 模型必须是真实的（桩驱动直接拒绝）"
st=$(curl -s -m 10 -b "$JAR" -H "Authorization: Bearer $TOK_A" "$BASE/api/model/status")
echo "$st" | grep -q '"real":true' || no "模型状态" "driver 非真实：$st（先 scripts/unblock.sh --model-key …）"
ok "模型状态" "$(echo "$st" | head -c 80)"

echo "== 2) 下目标"
SID=$(curl -s -m 10 -b "$JAR" -H "Authorization: Bearer $TOK_A" -H 'content-type: application/json' \
  -d '{"title":"真模型验收"}' "$BASE/api/sessions" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
RID=$(curl -s -m 20 -b "$JAR" -H "Authorization: Bearer $TOK_A" -H 'content-type: application/json' \
  -d "{\"input\":\"$GOAL\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
[ -n "$RID" ] && ok "创建 run" "$RID" || no "创建 run" "无 runId"

echo "== 3) 等审批（最多 120s）"
for i in $(seq 1 120); do
  evs=$(curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOK_A" "$BASE/api/runs/$RID/events?replay=1")
  echo "$evs" | grep -q 'event: approval\.requested' && break
  echo "$evs" | grep -qE 'event: run\.(finished|failed|canceled)' && no "审批" "未到审批就结束：$(echo "$evs" | grep -oE 'event: [a-z.]+' | tr '\n' ' ')"
  sleep 1
done
echo "$evs" | grep -q 'event: approval\.requested' || no "审批" "120s 内未出现 approval.requested"
ok "审批卡" "$(echo "$evs" | grep -A1 'event: approval\.requested' | tail -1 | head -c 100)"

echo "== 4) 批准并等待完成"
curl -s -m 20 -b "$JAR" -H "Authorization: Bearer $TOK_A" -H 'content-type: application/json' \
  -d '{"decision":"allow_once"}' "$BASE/api/approvals/$RID" >/dev/null
for i in $(seq 1 120); do
  evs=$(curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOK_A" "$BASE/api/runs/$RID/events?replay=1")
  echo "$evs" | grep -q 'event: run\.finished' && break
  echo "$evs" | grep -q 'event: run\.failed' && no "运行" "失败：$(echo "$evs" | grep -A1 'event: run\.failed' | tail -1)"
  sleep 1
done
echo "$evs" | grep -q 'event: run\.finished' || no "运行" "120s 内未完成"

echo "== 5) 证据"
seq=$(echo "$evs" | grep -oE 'event: [a-z.]+' | awk '{print $2}' | tr '\n' ' ')
ok "事件序列" "$seq"
echo "$evs" | grep -q 'event: artifact\.created' && ok "产物" "$(echo "$evs" | grep -A1 'event: artifact\.created' | tail -1 | head -c 120)" || echo "  … 本次未产生产物（工具可能非写文件）"
echo
echo "结论：① 真实链路通过（driver 为真实模型，事件由模型决策驱动）"
