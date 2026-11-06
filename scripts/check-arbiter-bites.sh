#!/usr/bin/env bash
# 验收器"咬人"自检：人为制造"审批后不产出"，验收 ① 必须变红。
# 这是对验收器的测试——防止它变成只发绿灯的装饰。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
WORK=$(mktemp -d); MOCK=8991; APP=8992
cleanup(){ for p in $MOCK $APP; do local pid; pid=$(ss -ltnp 2>/dev/null | awk -v pp=":$p " '$0 ~ pp {print $NF}' | grep -oP 'pid=\K[0-9]+' | head -1); [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/mock.mjs" <<'JS'
import { createServer } from 'node:http'
// 审批会发生（fs.write 需确认），但路径越界 → 工具失败、没有 artifact
createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const b=(()=>{try{return JSON.parse(raw)}catch{return {}}})()
  const hasTool=(b.messages??[]).some(m=>m.role==='tool')
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({choices:[{message: hasTool
    ? {role:'assistant',content:'写不进去'}
    : {tool_calls:[{id:'c1',type:'function',function:{name:'fs.write',arguments:JSON.stringify({path:'../../escape.md',content:'x'})}}]}}]}))
})}).listen(Number(process.env.MOCK_PORT))
JS
MOCK_PORT=$MOCK node "$WORK/mock.mjs" >/dev/null 2>&1 &
sleep 1
APP_PASSWORD='bite-pw' APP_SESSION_SECRET='bite-secret-1234567890' \
CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"},"tok_b":{"tenantId":"t_b","userId":"u_b"}}' \
MODEL_BASE_URL="http://127.0.0.1:$MOCK/v1" MODEL_NAME='mock-bite' MODEL_API_KEY='sk-m' \
PORT=$APP DB_PATH="$WORK/cube.db" WORKSPACE_ROOT="$WORK/ws" node impl/src/server.mjs >/dev/null 2>&1 &
for i in $(seq 1 40); do sleep 0.5; [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$APP/healthz")" = 200 ] && break; done

out=$(PW='bite-pw' TOK_A=tok_a TOK_B=tok_b ./scripts/acceptance.sh "http://127.0.0.1:$APP" 2>&1)
line=$(printf '%s\n' "$out" | grep -E '审批后产出' | head -1)
sum=$(printf '%s\n' "$out" | grep -E '^== 汇总' | tail -1)
printf '%s\n' "$line"
printf '%s\n' "$sum"
# 预期：审批后产出必须 ✖，且汇总里 fail >= 1
if printf '%s' "$line" | grep -q '✖' && printf '%s' "$sum" | grep -qE 'fail=[1-9]'; then
  echo "OK: 验收器会咬人（制造故障后 ① 变红）"
  exit 0
fi
echo "FAIL: 验收器没有被故障触发（判据太松）"
exit 1
