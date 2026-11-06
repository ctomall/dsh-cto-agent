#!/usr/bin/env bash
# 孤儿 run 演练：模拟「工具执行中途进程被杀」，验证启动收敛把 running 标成 failed。
# 全程在数据库副本 + 临时实例上做，不碰线上数据。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC="${SRC_DB:-/var/lib/cube-agent/cube.db}"
PORT="${1:-8799}"
WORK=$(mktemp -d); PID=""
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
pass=0; fail=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }

echo "== 1) 准备数据库副本"
cp "$SRC" "$WORK/cube.db" && ok "复制生产库" "$(basename "$SRC") → 临时副本" || { no "复制生产库" "失败"; exit 1; }

echo "== 2) 注入孤儿 run（模拟执行中途被杀）"
RUN="r_orphan_drill_$$"
DB="$WORK/cube.db" node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB);
const id=process.argv[1], now=new Date().toISOString();
d.prepare("insert into sessions (id,tenant_id,user_id,title) values (?,?,?,?)").run("s_drill","t_a","u_a","孤儿演练");
d.prepare("insert into runs (id,status,started_at,tenant_id,session_id) values (?,?,?,?,?)").run(id,"running",now,"t_a","s_drill");
' "$RUN" && ok "注入 running" "$RUN" || { no "注入 running" "失败"; exit 1; }

echo "== 3) 起临时实例（启动时应自动收敛）"
APP_PASSWORD= APP_SESSION_SECRET= CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"}}' \
  PORT="$PORT" DB_PATH="$WORK/cube.db" WORKSPACE_ROOT="$WORK/ws" \
  node impl/src/server.mjs >"$WORK/app.log" 2>&1 &
PID=$!
for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/healthz")" = 200 ] && { ok "临时实例就绪" "${i}s"; break; }
  sleep 0.5
done

res=$(DB="$WORK/cube.db" node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB,{readOnly:true});
const id=process.argv[1];
console.log(JSON.stringify({
  status: d.prepare("select status from runs where id=?").get(id)?.status ?? null,
  failedEvents: d.prepare("select count(*) c from events where run_id=? and type=\x27run.failed\x27").get(id).c,
  audits: d.prepare("select count(*) c from audit_log where action=\x27run_interrupted\x27 and detail_json like ?").get("%"+id+"%").c,
  pending: d.prepare("select count(*) c from run_pending where run_id=?").get(id).c,
}));
' "$RUN")
echo "  … 收敛结果：$res"
printf '%s' "$res" | grep -q '"status":"failed"' && ok "终态 failed" failed || no "终态 failed" "$res"
printf '%s' "$res" | grep -q '"failedEvents":1' && ok "run.failed 事件" 1 || no "run.failed 事件" "$res"
printf '%s' "$res" | grep -q '"audits":1' && ok "审计 run_interrupted" 1 || no "审计 run_interrupted" "$res"
printf '%s' "$res" | grep -q '"pending":0' && ok "无残留快照" 0 || no "无残留快照" "$res"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
