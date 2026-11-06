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

lc=$(require_login "$BASE" "$JAR" "$PW") || { no "登录" "重试后仍无法建立会话（$lc）"; exit 1; }
case "$lc" in
  302) ok "登录" 302 ;;
  401) ok "登录" "该实例未开启口令门（401），跳过" ;;
  *) no "登录" "期望 302，实际 $lc" ;;
esac

SID=$(curl -s -m 15 "${H[@]}" -d '{"title":"并发冒烟"}' "$BASE/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$SID" ] && ok "创建会话" "$SID" || { no "创建会话" "空"; exit 1; }

THROTTLED="$IDS.throttled"; : > "$THROTTLED"
fire() { # fire <i>
  local i="$1" code
  code=$(curl -s -m 40 -o /tmp/run_$i.json -w '%{http_code}' "${H[@]}" -d "{\"input\":\"写第 $i 份报告\",\"sessionId\":\"$SID\"}" "$BASE/api/runs")
  if [ "$code" = 202 ]; then
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("runId",""))' /tmp/run_$i.json >> "$IDS"
  elif [ "$code" = 429 ]; then
    echo "$i" >> "$THROTTLED"
  fi
}
for i in $(seq 1 "$N"); do fire "$i" & done
wait
# 被限流（runs 桶 20/分）就等窗口过后重试一次，避免把限流误判成失败
if [ -s "$THROTTLED" ]; then
  echo "  … 有 $(grep -c . "$THROTTLED") 个请求被限流，等待 62s 重试"
  sleep 62
  : > "$THROTTLED"
  for i in $(seq 1 "$N"); do
    grep -qxF "$i" <(seq 1 "$N") >/dev/null 2>&1 || true
    [ -s /tmp/run_$i.done ] && continue
    fire "$i" &
  done
  wait
fi
: > "$THROTTLED"
got=$(grep -c . "$IDS" || true)
thr=$(grep -c . "$THROTTLED" || true)
if [ "$got" = "$N" ]; then ok "并发发起" "$got 个"
elif [ "$thr" -gt 0 ] && [ "$got" -gt 0 ]; then
  ok "并发发起" "$got 个成功，$thr 个被限流（runs 桶 20/分，属预期）"
else no "并发发起" "期望 $N，成功 $got，限流 $thr"; fi

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
printf '%s' "$res" | grep -q '"bad":0' && ok "全部 done 且 seq 连续无重复" "$got 个 run" || no "并发一致性" "$res"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
