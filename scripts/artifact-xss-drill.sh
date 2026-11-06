#!/usr/bin/env bash
# 产物文件名载荷演练（可重复、零生产影响）：库副本 + 临时实例 + 浏览器检查。
# 用法：scripts/artifact-xss-drill.sh [PORT]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT="${1:-8797}"
SRC="${SRC_DB:-/var/lib/cube-agent/cube.db}"
WORK=$(mktemp -d); PID=""
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
pass=0; fail=0
ok(){ printf '  ✔ %-32s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-32s %s\n' "$1" "$2"; fail=$((fail+1)); }

echo "== 1) 库副本 + 临时实例（无口令门）"
cp "$SRC" "$WORK/cube.db" || { echo "复制失败"; exit 1; }
APP_PASSWORD= APP_SESSION_SECRET= CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"}}' \
  PORT="$PORT" DB_PATH="$WORK/cube.db" WORKSPACE_ROOT="$WORK/ws" \
  node impl/src/server.mjs >"$WORK/app.log" 2>&1 &
PID=$!
for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/healthz")" = 200 ] && { ok "临时实例就绪" "${i}"; break; }
  sleep 0.5
done
grep -q EADDRINUSE "$WORK/app.log" && { no "端口占用" "$PORT"; exit 1; }

echo "== 2) 造 run 并注入恶意产物路径"
H=(-H "Authorization: Bearer tok_a" -H 'content-type: application/json')
SID=$(curl -s -m 10 "${H[@]}" -d '{"title":"产物路径载荷"}' "http://127.0.0.1:$PORT/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
RID=$(curl -s -m 20 "${H[@]}" -d "{\"input\":\"写一份报告\",\"sessionId\":\"$SID\"}" "http://127.0.0.1:$PORT/api/runs" | python3 -c 'import json,sys;print(json.load(sys.stdin)["runId"])')
sleep 1
curl -s -o /dev/null -m 20 "${H[@]}" -d '{"decision":"allow_once"}' "http://127.0.0.1:$PORT/api/approvals/$RID"
sleep 1
DB="$WORK/cube.db" RID="$RID" node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.env.DB);
const rid=process.env.RID;
const seq=d.prepare("select coalesce(max(seq),0) m from events where run_id=?").get(rid).m+1;
const evil=`<img src=x onerror="document.title=\x27ART-XSS\x27">.md`;
d.prepare("insert into events (run_id,seq,type,payload_json,ts) values (?,?,?,?,?)")
 .run(rid,seq,"artifact.created",JSON.stringify({path:evil,mime:"text/markdown",size:42}),new Date().toISOString());
' && ok "注入恶意路径" "$RID" || { no "注入恶意路径" "失败"; exit 1; }

echo "== 3) 浏览器检查（CDP）"
out=$(SID="$SID" PORT="$PORT" timeout 90 node -e '
const SID=process.env.SID, PORT=process.env.PORT, BASE=`http://127.0.0.1:${PORT}`
const t = await (await fetch("http://127.0.0.1:9222/json/new?about:blank",{method:"PUT"})).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id=0; const pend=new Map()
const raw=(m,p={},ms=15000)=>Promise.race([new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))}),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout "+m)),ms))])
ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const {res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result)}})
await new Promise((r)=>ws.addEventListener("open",r,{once:true}))
const ev=async(x)=>(await raw("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true})).result?.value
await raw("Runtime.enable"); await raw("Page.enable")
// 临时实例未开口令门：浏览器只能用 ?token=（否则前端拿不到产物，页面会显示空面板）
await raw("Page.navigate",{url:`${BASE}/?sid=${SID}&token=tok_a`},20000)
await new Promise((r)=>setTimeout(r,3000))
const o=await ev(`({title:document.title,imgs:document.querySelectorAll(".stream-inner img").length,scripts:document.querySelectorAll(".stream-inner script").length,textHasPayload:[...document.querySelectorAll(".artifact .nm")].some(n=>n.textContent.includes("onerror"))})`)
console.log(JSON.stringify(o))
await raw("Page.close",{},5000).catch(()=>{}); ws.close()
' 2>&1 | tail -1)
echo "  … 浏览器结果：$out"
printf '%s' "$out" | grep -q '"title":"cube-agent"' && ok "标题未被改写" cube-agent || no "标题被改写" "$out"
printf '%s' "$out" | grep -q '"imgs":0' && ok "无 img 注入" 0 || no "有 img 注入" "$out"
printf '%s' "$out" | grep -q '"scripts":0' && ok "无 script 注入" 0 || no "有 script 注入" "$out"
# 载荷是否出现在接口返回里，决定 textHasPayload 这条是断言还是跳过（避免把"列表没加载"误判成失败）
if curl -s -m 10 -H "Authorization: Bearer tok_a" "http://127.0.0.1:$PORT/api/sessions/$SID/artifacts" | grep -q onerror; then
  printf '%s' "$out" | grep -q '"textHasPayload":true' && ok "载荷按文本渲染" true || no "载荷未按文本渲染" "$out"
else
  printf '  ○ %-32s %s\n' "载荷按文本渲染" "接口未返回该产物，跳过（未验证）"
fi

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
