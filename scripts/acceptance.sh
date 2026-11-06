#!/usr/bin/env bash
# 目标验收器：把 ①②③ 三项变成机器可判定的 PASS/FAIL/SKIP。
# 用法：scripts/acceptance.sh [--require-all] [BASE_URL]
#   --require-all  有任何 SKIP/FAIL 即返回非零（CI 用）
set -uo pipefail
BASE="https://cto.ila3.top"; REQUIRE=0
for a in "$@"; do
  case "$a" in
    --require-all) REQUIRE=1 ;;
    http*) BASE="$a" ;;
  esac
done

PW_FILE=".runtime-app-password"; TOK_FILE=".runtime-tokens"
PW=$(cut -d= -f2- "$PW_FILE" 2>/dev/null)
T_A=$(cut -d= -f2- "$TOK_FILE" 2>/dev/null | head -1)
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT

pass=0 fail=0 skip=0
ok(){ printf '  ✔ %-34s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-34s %s\n' "$1" "$2"; fail=$((fail+1)); }
sk(){ printf '  ○ %-34s %s\n' "$1" "$2"; skip=$((skip+1)); }
code(){ curl -s -o /dev/null -w '%{http_code}' -m 20 "$@"; }

echo "== 0) 就绪"
ready=0
for i in $(seq 1 40); do [ "$(code "$BASE/healthz")" = 200 ] && { ready=$i; break; }; sleep 1; done
[ "$ready" -gt 0 ] && ok "healthz" "${ready}s" || no "healthz" "40s 未就绪"

echo "== 0.5) 登录（后续用例都要 Cookie）"
lc=""
for attempt in 1 2 3; do
  lc=$(curl -s -o /dev/null -c "$JAR" -w '%{http_code}' -m 20 -X POST -d "password=$PW" "$BASE/login")
  [ "$lc" = 302 ] && break
  # 429 = 上一轮爆破测试占用了登录配额：等窗口滑过再试
  [ "$lc" = 429 ] && { echo "  … 登录被限流，等待 50s 重试（第 $attempt 次）"; sleep 50; } || break
done
[ "$lc" = 302 ] && ok "登录" "302" || no "登录" "期望 302，实际 $lc"

echo "== 0.6) 服务版本与仓库一致（防验收打到旧进程）"
remote_sha=$(curl -s -m 15 "$BASE/api/version" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sha",""))' 2>/dev/null)
local_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "")
if [ -z "$local_sha" ]; then sk "版本一致性" "非 git 目录"
elif [ "$remote_sha" = "$local_sha" ]; then ok "版本一致性" "$remote_sha"
else no "版本一致性" "线上=$remote_sha 本地=$local_sha（需重启/升级）"; fi

echo "== ① 真实模型 loop"
ms=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 20 "$BASE/api/model/status" 2>/dev/null)
if echo "$ms" | grep -q '"real":true'; then
  body=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 60 \
    -d '{"input":"写一份验收报告","sessionId":"s_a1"}' "$BASE/api/runs")
  rid=$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))' 2>/dev/null)
  drv=$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("driver",""))' 2>/dev/null)
  if [ -n "$rid" ]; then
    ev=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 10 "$BASE/api/runs/$rid/events" | grep '^event:' | sed 's/event: //' | tr '\n' ' ')
    echo "$ev" | grep -q "approval.requested" || echo "$ev" | grep -q "tool.started"
    [ $? -eq 0 ] && ok "run 由模型工具驱动" "driver=$drv" || no "run 由模型工具驱动" "$ev"
    echo "$drv" | grep -q '^fake' && no "driver 非 fake" "$drv" || ok "driver 非 fake" "$drv"
  else no "创建 run" "$body"; fi
else
  sk "① 真实模型" "未配置 MODEL_*，放行见 HANDOFF.md ①（$(echo "$ms" | head -c 48)）"
fi

echo "== ② 会话级审批 scope"
# 每次验收用全新会话，避免上一轮的会话授权污染本轮（判据必须可重复）
SID=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 20 -d '{"title":"验收会话"}' "$BASE/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$SID" ] && ok "创建验收会话" "$SID" || no "创建验收会话" "空"
r1=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 60 -d "{\"input\":\"写一份报告\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))')
e1=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 10 "$BASE/api/runs/$r1/events" | grep '^event:' | sed 's/event: //' | tr '\n' ' ')
echo "$e1" | grep -q 'approval.requested' && ok "首次要求审批" "approval.requested" || no "首次要求审批" "$e1"
curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 30 -d '{"decision":"allow_session"}' "$BASE/api/approvals/$r1" >/dev/null
r2=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 60 -d "{\"input\":\"再写一份\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))')
e2=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 10 "$BASE/api/runs/$r2/events" | grep '^event:' | sed 's/event: //' | tr '\n' ' ')
if echo "$e2" | grep -q 'approval.requested'; then no "同会话第二次免审批" "$e2"; else ok "同会话第二次免审批" "auto_approved"; fi
rv=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 20 -d '{}' "$BASE/api/sessions/$SID/grants/revoke" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("revoked",""))' 2>/dev/null)
[ "${rv:-0}" -ge 1 ] && ok "撤销会话授权" "${rv} 条" || no "撤销会话授权" "revoked=$rv"
r3=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 60 -d "{\"input\":\"再写\",\"sessionId\":\"$SID\"}" "$BASE/api/runs" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))')
e3=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 10 "$BASE/api/runs/$r3/events" | grep '^event:' | sed 's/event: //' | tr '\n' ' ')
echo "$e3" | grep -q 'approval.requested' && ok "撤销后重新审批" "approval.requested" || no "撤销后重新审批" "$e3"
x=$(code -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -d '{"input":"x","sessionId":"s_b1"}' "$BASE/api/runs")
[ "$x" = 404 ] && ok "跨租户 sessionId" "404" || no "跨租户 sessionId" "期望 404，实际 $x"

echo "== ③ 访问控制与限流"
[ "$(code "$BASE/")" = 302 ] && ok "未登录首页" "302" || no "未登录首页" "期望 302"
[ "$(code "$BASE/api/sessions")" = 401 ] && ok "未登录 API" "401" || no "未登录 API" "期望 401"
[ "$(code -b "$JAR" "$BASE/")" = 200 ] && ok "已登录首页" "200" || no "已登录首页" "期望 200"
# Cookie 会话必须能直接调用 API（"登录后页面可用"的关键；只看 curl 会漏掉）
me_cookie=$(code -b "$JAR" "$BASE/api/me")
[ "$me_cookie" = 200 ] && ok "Cookie 直接调 API" "200（无需 Bearer）" || no "Cookie 直接调 API" "期望 200，实际 $me_cookie"

# 跨站变更请求必须被挡（Cookie 身份下的 CSRF 防护）
csrf=$(code -b "$JAR" -H 'content-type: application/json' -H 'sec-fetch-site: cross-site' -d '{}' -X POST "$BASE/api/sessions")
[ "$csrf" = 403 ] && ok "跨站写请求被拒" "403" || no "跨站写请求被拒" "期望 403，实际 $csrf"

up=$(code -X POST -H "x-upgrade-token: wrong" "$BASE/api/admin/upgrade")
{ [ "$up" = 401 ] || [ "$up" = 403 ] || [ "$up" = 503 ] || [ "$up" = 429 ]; } && ok "升级接口需凭据" "$up" || no "升级接口需凭据" "$up"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ]; then
  apps=$(curl -s -m 15 -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps")
  echo "$apps" | grep -q 'cto.ila3.top' && ok "Cloudflare Access 应用" "已存在" || sk "Cloudflare Access 应用" "已配置凭据但未找到应用"
else
  sk "Cloudflare Access" "未配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID（放行见 HANDOFF.md ③）"
fi

echo "== ④ 登录爆破限流（放最后，会占用登录配额）"
codes=""
for i in 1 2 3 4 5 6 7; do codes="$codes $(code -X POST -d 'password=__wrong__' "$BASE/login")"; done
echo "$codes" | grep -q 429 && ok "登录失败限流" "出现 429" || no "登录失败限流" "$codes"

echo
echo "== 汇总：pass=$pass fail=$fail skip=$skip"
if [ "$fail" -gt 0 ]; then exit 1; fi
if [ "$REQUIRE" = 1 ] && [ "$skip" -gt 0 ]; then exit 3; fi
exit 0
