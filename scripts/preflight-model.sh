#!/usr/bin/env bash
# 接通真实模型前的体检：缺什么、地址通不通、key 文件权限对不对。
# 用法：scripts/preflight-model.sh [--json]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

JSON=0; [ "${1:-}" = "--json" ] && JSON=1
ENV_FILE=/etc/cube-agent/env
KEY_FILE=/etc/cube-agent/model.key
BASE_URL="${MODEL_BASE_URL:-}"; MODEL="${MODEL_NAME:-}"; KEY="${MODEL_API_KEY:-}"; KEYF="${MODEL_API_KEY_FILE:-}"
if [ -z "$BASE_URL" ] && sudo test -f "$ENV_FILE" 2>/dev/null; then
  BASE_URL=$(sudo grep -E '^MODEL_BASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  MODEL=$(sudo grep -E '^MODEL_NAME=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  KEYF=$(sudo grep -E '^MODEL_API_KEY_FILE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
fi

state() { printf '%-28s %s\n' "$1" "$2"; }
rc=0

echo "== 配置"
[ -n "$BASE_URL" ] && state "MODEL_BASE_URL" "$BASE_URL" || { state "MODEL_BASE_URL" "缺失"; rc=2; }
[ -n "$MODEL" ] && state "MODEL_NAME" "$MODEL" || { state "MODEL_NAME" "缺失"; rc=2; }
if [ -n "$KEY" ]; then state "MODEL_API_KEY" "已提供（环境变量，长度 ${#KEY}）"
elif [ -n "$KEYF" ] && sudo test -f "$KEYF" 2>/dev/null; then
  perm=$(sudo stat -c '%a' "$KEYF")
  state "MODEL_API_KEY_FILE" "$KEYF（权限 $perm）"
  [ "$perm" = "600" ] || { state "  文件权限" "应为 600，当前 $perm"; rc=2; }
elif sudo test -f "$KEY_FILE" 2>/dev/null; then
  state "MODEL_API_KEY_FILE" "$KEY_FILE（存在，但 env 未指向）"; rc=2
else
  state "MODEL_API_KEY(_FILE)" "缺失"; rc=2
fi

echo "== 连通性"
host=$(printf '%s' "$BASE_URL" | sed -E 's#^https?://##; s#/.*$##; s#:.*$##')
if [ -z "$host" ]; then state "provider host" "无法解析（BASE_URL 缺失）"
else
  node -e "
  const net=require('node:net'),dns=require('node:dns').promises;
  const host=process.argv[1];
  (async()=>{
    try { const a=await dns.lookup(host); console.log('  DNS '+host+' → '+(a.address||'')); } catch(e){ console.log('  DNS 解析失败: '+e.code); process.exit(3); }
    const s=net.connect({host,port:443,timeout:5000});
    s.on('connect',()=>{ console.log('  TCP 443 可达'); s.destroy(); process.exit(0); });
    s.on('timeout',()=>{ console.log('  TCP 443 超时'); s.destroy(); process.exit(3); });
    s.on('error',(e)=>{ console.log('  TCP 443 失败: '+e.code); process.exit(3); });
  })();
  " "$host" || rc=3
fi

echo "== 结论"
if [ "$rc" = 0 ]; then
  echo "  已就绪 → 运行：node scripts/model-doctor.mjs --probe && ./scripts/acceptance.sh --require-all http://127.0.0.1:8787"
elif [ "$rc" = 2 ]; then
  echo "  未配置完成：按上面缺失项补齐后重跑；一键方式：scripts/unblock.sh --model-key sk-... --probe"
else
  echo "  配置齐全但网络不通：先解决出口/DNS，再重跑本脚本"
fi
[ "$JSON" = 1 ] && printf '{"ready":%s,"rc":%s}\n' "$([ "$rc" = 0 ] && echo true || echo false)" "$rc"
exit "$rc"
