#!/usr/bin/env bash
# 并发冒烟：同时发起 N 个 run，全部批准后校验
#   · 每个 run 终态 done
#   · 事件 seq 必须是 1..N 连续
#   · 没有重复 seq（单写者 SQLite + 事件序号逻辑）
# 用法：scripts/concurrency-smoke.sh [BASE] [N]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:-http://127.0.0.1:8787}"
N="${2:-5}"
. scripts/lib-login.sh
pass=0; fail=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }

PW=$(cut -d= -f2- .runtime-app-password 2>/dev/null)
TOK="${TOK:-}"
if [ -z "$TOK" ]; then
  TOK=$(sudo sed -n 's/^CUBE_TOKENS=//p' /etc/cube-agent/env | tr -d '\r\n' \
    | python3 -c 'import json,sys; print(next(iter(json.load(sys.stdin))))' 2>/dev/null)
fi
JAR=$(mktemp); IDS=$(mktemp); trap 'rm -f "$JAR" "$IDS"' EXIT
H=(-b "$JAR" -H "Authorization: Bearer $TOK" -H 'content-type: application/json')

lc=$(login_cookie "$BASE" "$JAR" "$PW")
[ "$lc" = 302 ] && ok "登录" 302 || no "登录" "期望 302，实际 $lc"

SID=$(curl -s -m 15 "${H[@]}" -d '{"title":"并发冒烟"}' "$BASE/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$SID" ] && ok "创建会话" "$SID" || { no "创建会话" "空"; exit 1; }

for i in $(seq 1 "$N"); do
  ( curl -s -m 40 "${H[@]}" -d "{\"input\":\"写第 $i 份报告\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" \
      | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))' >> "$IDS" ) &
done
wait
got=$(grep -c . "$IDS" || true)
[ "$got" = "$N" ] && ok "并发发起" "$got 个" || no "并发发起" "期望 $N，实际 $got"

for r in $(cat "$IDS"); do
  curl -s -o /dev/null -m 30 "${H[@]}" -d '{"decision":"allow_once"}' "$BASE/api/approvals/$r" &
done
wait
sleep 2

res=$(node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB??"/var/lib/cube-agent/cube.db",{readOnly:true});
const ids=process.argv.slice(1);
let bad=0, detail=[];
for (const id of ids) {
  const st=d.prepare("select status from runs where id=?").get(id)?.status;
  const seqs=d.prepare("select seq from events where run_id=? order by seq").all(id).map(r=>r.seq);
  const contiguous = seqs.length>0 && seqs.every((s,i)=>s===i+1);
  const dup = new Set(seqs).size !== seqs.length;
  if (st!=="done" || !contiguous || dup) { bad++; detail.push({id, st, events: seqs.length, contiguous, dup}); }
}
console.log(JSON.stringify({ total: ids.length, bad, detail }));
' $(cat "$IDS"))
echo "  … 结果：$res"
printf '%s' "$res" | grep -q '"bad":0' && ok "全部 done 且 seq 连续无重复" "$N 个 run" || no "并发一致性" "$res"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
