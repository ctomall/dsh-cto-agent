#!/usr/bin/env bash
# 验证"操作者拿到 key 后的第 5 步"（first-real-run.sh）本身可用：
# 起一个 mock 后端（真驱动 + 真工具链），跑 first-real-run，断言它给出「真实链路通过」。
# 这样在没 key 的时候，也能保证放行脚本不会在关键时刻掉链子。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
WORK=$(mktemp -d); MOCK=8977; APP=8978
cleanup(){ for p in $MOCK $APP; do local pid; pid=$(ss -ltnp 2>/dev/null | awk -v pp=":$p " '$0 ~ pp {print $NF}' | grep -oP 'pid=\K[0-9]+' | head -1); [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/mock.mjs" <<'JS'
import { createServer } from 'node:http'
createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const b=(()=>{try{return JSON.parse(raw)}catch{return {}}})()
  const hasTool=(b.messages??[]).some(m=>m.role==='tool')
  res.writeHead(200,{'content-type':'application/json'})
  if(!hasTool){
    res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'c1',type:'function',function:{name:'fs.write',arguments:JSON.stringify({path:'real-run.md',content:'# 产物'})}}]}}]}))
  } else {
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'已写入 real-run.md'},finish_reason:'stop'}]}))
  }
})}).listen(Number(process.env.MOCK_PORT))
JS
MOCK_PORT=$MOCK node "$WORK/mock.mjs" >/dev/null 2>&1 &
sleep 1
APP_PASSWORD='fr-pw' APP_SESSION_SECRET='fr-secret-1234567890' \
CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"}}' \
MODEL_BASE_URL="http://127.0.0.1:$MOCK/v1" MODEL_NAME='mock' MODEL_API_KEY='sk-m' \
PORT=$APP DB_PATH="$WORK/cube.db" WORKSPACE_ROOT="$WORK/ws" node impl/src/server.mjs >/dev/null 2>&1 &
for i in $(seq 1 40); do sleep 0.5; [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$APP/healthz")" = 200 ] && break; done

out=$(PW='fr-pw' TOK=tok_a timeout 200 ./scripts/first-real-run.sh "http://127.0.0.1:$APP" 2>&1)
printf '%s\n' "$out" | grep -E '^\s+(✔|✖)' | tail -8
if printf '%s' "$out" | grep -q '① 真实链路通过'; then
  echo "OK: first-real-run 可用（mock 后端，真驱动路径）"
  exit 0
fi
echo "FAIL: first-real-run 未给出通过结论"
exit 1
