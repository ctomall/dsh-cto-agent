#!/usr/bin/env bash
# 恢复演练：把备份还原到临时库，用独立实例起一遍，验证数据可用——不碰线上。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT="${1:-8797}"
FROM_LATEST=0
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cube-agent}"
for a in "$@"; do [ "$a" = "--from-latest" ] && FROM_LATEST=1; done
SRC_DB="${SRC_DB:-/var/lib/cube-agent/cube.db}"
WORK=$(mktemp -d); LOG="$WORK/app.log"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }

if [ "$FROM_LATEST" = 1 ]; then
  echo "== 1) 取定时器产出的最新备份（灾难现场真实存在的那份）"
  BK=$(ls -t "$BACKUP_DIR"/cube-*.db 2>/dev/null | head -1)
  [ -n "$BK" ] && [ -f "$BK" ] && ok "最新备份存在" "$(basename "$BK")（$(stat -c %s "$BK") 字节）" || { no "最新备份存在" "$BACKUP_DIR 下没有 cube-*.db"; exit 1; }
  ic=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('pragma integrity_check').get().integrity_check)" "$BK" 2>&1)
  [ "$ic" = "ok" ] && ok "完整性检查" "integrity_check=ok" || no "完整性检查" "$ic"
else
  echo "== 1) 用备份脚本产出一份快照"
  out=$(node scripts/backup.mjs --db "$SRC_DB" --out "$WORK/bak" 2>&1) || { echo "$out"; exit 1; }
  BK=$(printf '%s\n' "$out" | sed -n 's/^备份完成: \(.*\)（.*/\1/p')
  [ -f "$BK" ] && ok "备份产出" "$(basename "$BK")" || { no "备份产出" "$out"; exit 1; }
fi

echo "== 2) 还原到独立库（模拟灾备恢复）"
cp "$BK" "$WORK/restored.db"
ok "还原副本" "$(basename "$WORK/restored.db")"

echo "== 3) 用还原库起独立实例（:${PORT}）"
APP_PASSWORD= APP_SESSION_SECRET= CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"}}' \
  PORT="$PORT" DB_PATH="$WORK/restored.db" WORKSPACE_ROOT="$WORK/ws" \
  node impl/src/server.mjs >"$LOG" 2>&1 &
PID=$!
for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/healthz")" = 200 ] && break
  sleep 0.5
done
hc=$(curl -s -m 5 "http://127.0.0.1:$PORT/healthz" | grep -c '"ok":true')
[ "$hc" = 1 ] && ok "还原实例 /healthz" "ok" || { no "还原实例 /healthz" "启动失败"; sed -n '1,5p' "$LOG"; }

echo "== 4) 还原实例能读到还原数据"
ov=$(curl -s -m 10 -H 'authorization: Bearer tok_a' "http://127.0.0.1:$PORT/api/overview")
echo "$ov" | grep -q '"sessions"' && ok "总览 API 可用" "sessions 字段存在" || no "总览 API 可用" "响应异常"
msgs=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('select count(*) c from messages').get().c)" "$WORK/restored.db")
echo "$ov" | grep -q "\"messages\":$msgs" && ok "行数一致" "messages=$msgs" || no "行数一致" "备份 messages=$msgs 与 API 不符"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
