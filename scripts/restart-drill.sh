#!/usr/bin/env bash
# 重启韧性演练：审批挂起时重启服务，恢复后批准，必须「只执行一次」。
# 用法：sudo scripts/restart-drill.sh [BASE] [--sigkill]
#   --sigkill  用 kill -9 代替 systemctl restart（验证非优雅退出）
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="http://127.0.0.1:8787"; MODE="graceful"
for a in "$@"; do
  case "$a" in
    --sigkill) MODE="sigkill" ;;
    http*) BASE="$a" ;;
  esac
done
. scripts/lib-login.sh
pass=0; fail=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }

PW=$(cut -d= -f2- .runtime-app-password 2>/dev/null)
TOK="${TOK:-}"
if [ -z "$TOK" ]; then
  TOK=$(sudo sed -n 's/^CUBE_TOKENS=//p' /etc/cube-agent/env | tr -d '\r\n' \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(iter(d)))' 2>/dev/null)
fi
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
H=(-b "$JAR" -H "Authorization: Bearer $TOK" -H 'content-type: application/json')

lc=$(require_login "$BASE" "$JAR" "$PW") || { no "登录" "重试后仍无法建立会话（$lc）"; exit 1; }
[ "$lc" = 302 ] && ok "登录" 302 || no "登录" "期望 302，实际 $lc"

SID=$(curl -s -m 15 "${H[@]}" -d '{"title":"重启演练"}' "$BASE/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
RUN=$(curl -s -m 30 "${H[@]}" -d "{\"input\":\"写一份报告\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))')
sleep 1
[ -n "$RUN" ] && ok "创建并挂起" "$RUN" || { no "创建并挂起" "空"; exit 1; }

if [ "$MODE" = "sigkill" ]; then
  OLD=$(systemctl show -p MainPID --value cube-agent.service)
  sudo kill -9 "$OLD" 2>/dev/null || no "SIGKILL" "发送失败"
  ok "发送 SIGKILL" "旧 PID=$OLD"
else
  sudo systemctl restart cube-agent.service || no "重启服务" "失败"
fi
for i in $(seq 1 25); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/healthz")" = 200 ] && { ok "重启后恢复" "${i}s"; break; }
  sleep 1
done

pend=$(curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOK" "$BASE/api/sessions/$SID/pending")
printf '%s' "$pend" | grep -q "$RUN" && ok "重启后待审批仍在" "$RUN" || no "重启后待审批仍在" "$pend"

dec=$(curl -s -m 30 "${H[@]}" -d '{"decision":"allow_once"}' "$BASE/api/approvals/$RUN")
# v193 起审批接口是非阻塞的：立即回 {"status":"accepted"}，恢复在后台继续。
# 所以这里只断言"被接受"，真正的完成用下面轮询 + 事件统计来判（旧脚本曾断言 done，重构后误报红灯）。
printf '%s' "$dec" | grep -qE '"status":"(accepted|done)"' && ok "审批被接受" "$(printf '%s' "$dec" | head -c 40)" || no "审批被接受" "$dec"
for i in $(seq 1 30); do
  st=$(curl -s -m 10 -b "$JAR" -H "Authorization: Bearer $TOK" "$BASE/api/runs" 2>/dev/null | grep -o "\"$RUN\"[^}]*" | head -1)
  case "$st" in *'"done"'*) break ;; esac
  sleep 1
done

# 直接用 node 统计，避免额外依赖
stats=$(node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB??"/var/lib/cube-agent/cube.db",{readOnly:true});
const rid=process.argv[1];
const one=(sql)=>d.prepare(sql).get(rid).c;
console.log(JSON.stringify({
  status: d.prepare("select status from runs where id=?").get(rid).status,
  artifacts: one("select count(*) c from events where run_id=? and type=\x27artifact.created\x27"),
  tools: one("select count(*) c from events where run_id=? and type=\x27tool.finished\x27"),
}));
' "$RUN" 2>/dev/null)
echo "  … 统计：$stats"
printf '%s' "$stats" | grep -q '"status":"done"' && ok "run 终态 done" done || no "run 终态 done" "$stats"

# 硬杀之后库必须仍然完整（WAL + 单写者；这是"数据没坏"的直接证据，不是推断）
ic=$(node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB??"/var/lib/cube-agent/cube.db",{readOnly:true});
console.log(d.prepare("pragma integrity_check").get().integrity_check);
' 2>&1)
[ "$ic" = "ok" ] && ok "SIGKILL 后库完整" "integrity_check=ok" || no "SIGKILL 后库完整" "$ic"
printf '%s' "$stats" | grep -q '"artifacts":1' && ok "产物事件唯一" 1 || no "产物事件唯一" "$stats"
printf '%s' "$stats" | grep -q '"tools":1' && ok "工具只执行一次" 1 || no "工具只执行一次" "$stats"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
