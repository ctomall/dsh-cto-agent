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
# 口令来源优先级：环境变量 PW > .runtime-app-password > 空
# （干净克隆里没有 .runtime-app-password，靠环境变量即可完整复现）
PW="${PW:-$(cut -d= -f2- "$PW_FILE" 2>/dev/null)}"
# token 来源：环境变量 TOK_A/TOK_B > .runtime-tokens（干净克隆里用环境变量即可复现）
T_A="${TOK_A:-$(cut -d= -f2- "$TOK_FILE" 2>/dev/null | head -1)}"
T_B="${TOK_B:-$(cut -d= -f2- "$TOK_FILE" 2>/dev/null | sed -n '2p')}"
T_B="${T_B:-tok_b}"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT

pass=0 fail=0 skip=0
ok(){ printf '  ✔ %-34s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-34s %s\n' "$1" "$2"; fail=$((fail+1)); }
sk(){ printf '  ○ %-34s %s\n' "$1" "$2"; skip=$((skip+1)); }
# 网络层 000（链路丢包/连接超时）重试一次：本机实测公网 ~30% 连接失败，属环境而非应用问题
code(){
  local c
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$@") || c="000"
  if [ "$c" = "000" ]; then sleep 1; c=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$@") || c="000"; fi
  printf '%s' "$c"
}

echo "== 0) 就绪"
ready=0
for i in $(seq 1 40); do [ "$(code "$BASE/healthz")" = 200 ] && { ready=$i; break; }; sleep 1; done
[ "$ready" -gt 0 ] && ok "healthz" "${ready}s" || no "healthz" "40s 未就绪"

echo "== 0.2) 版本稳定（升级会重启进程，验收不能在重启窗口里跑）"
v1=$(curl -s -m 10 "$BASE/api/version" 2>/dev/null); sleep 1
v2=$(curl -s -m 10 "$BASE/api/version" 2>/dev/null)
if [ "$v1" = "$v2" ] && [ -n "$v1" ]; then
  ok "版本稳定" "$v2"
else
  echo "  … 版本在变（$v1 → $v2），等待 6s 让重启完成"
  sleep 6
  v3=$(curl -s -m 10 "$BASE/api/version" 2>/dev/null)
  v4=$(curl -s -m 10 "$BASE/api/version" 2>/dev/null)
  [ "$v3" = "$v4" ] && ok "版本稳定" "$v4" || no "版本稳定" "仍在变化：$v3 → $v4"
fi

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

# 部署目录完整性：线上跑的是 git 克隆时，克隆必须干净且 HEAD 与线上一致
DEPLOY_DIR="${DEPLOY_DIR:-/opt/cube-agent}"
if [ -d "$DEPLOY_DIR/.git" ]; then
  served=$(printf '%s' "$remote_sha")
  deploy_head=$(git -C "$DEPLOY_DIR" rev-parse --short HEAD 2>/dev/null)
  dirty=$(git -C "$DEPLOY_DIR" status --porcelain 2>/dev/null | head -5)
  if [ -n "$dirty" ]; then
    no "部署目录干净" "有未提交改动（热改线上？）：$(printf '%s' "$dirty" | tr '\n' ' ')"
  elif [ -n "$deploy_head" ] && [ "$deploy_head" != "$served" ]; then
    no "部署目录干净" "克隆 HEAD=$deploy_head 与线上=$served 不一致（可能改了没重启）"
  else
    ok "部署目录干净" "$DEPLOY_DIR @ $deploy_head"
  fi
fi

echo "== ① 真实模型 loop"
# 判据（对应目标原文）：模型选工具 → 审批 → 产出，且事件序列由模型行为决定。
# 真实模型第一步可能要几十秒，所以全部用"轮询 replay 事件"而不是一次性读流。
# 等待超时可配：默认值面向真实厂商（首步可能几十秒），自检脚本会把它调小
W_TOOL="${ACCEPT_WAIT_TOOL:-180}"
W_APPROVAL="${ACCEPT_WAIT_APPROVAL:-120}"
W_ARTIFACT="${ACCEPT_WAIT_ARTIFACT:-180}"
W_FINISH="${ACCEPT_WAIT_FINISH:-120}"
evwait() { # evwait <runId> <pattern> <timeout_s>
  local rid="$1" pat="$2" tmo="${3:-120}" i
  for i in $(seq 1 "$tmo"); do
    local txt
    txt=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 15 "$BASE/api/runs/$rid/events?replay=1" 2>/dev/null)
    echo "$txt" | grep -q "$pat" && { printf '%s' "$txt"; return 0; }
    sleep 1
  done
  printf '%s' "$txt"
  return 1
}
ms=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 20 "$BASE/api/model/status" 2>/dev/null)
if echo "$ms" | grep -q '"real":true'; then
  body=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 60 \
    -d '{"input":"写一份验收报告","sessionId":"s_a1"}' "$BASE/api/runs")
  rid=$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))' 2>/dev/null)
  drv=$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("driver",""))' 2>/dev/null)
  echo "$drv" | grep -q '^fake' && no "driver 非 fake" "$drv" || ok "driver 非 fake" "$drv"

  if [ -n "$rid" ]; then
    # 1) 模型必须真的调用工具（不是硬编码序列）
    if ev=$(evwait "$rid" "event: tool.started" "$W_TOOL"); then
      ok "模型选择了工具" "tool.started"
    else
      no "模型选择了工具" "$(echo "$ev" | grep '^event:' | tr '\n' ' ' | head -c 160)"
    fi
    # 2) 覆盖写必须落到审批（暂停）
    if ev=$(evwait "$rid" "event: approval.requested" "$W_APPROVAL"); then
      ok "审批暂停" "approval.requested"
      # 3) 批准后必须真的产出（恢复 → 工具执行 → 产物 → 收尾）
      curl -s -o /dev/null -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 30 \
        -d '{"decision":"allow_once"}' "$BASE/api/approvals/$rid"
      if ev2=$(evwait "$rid" "event: artifact.created" "$W_ARTIFACT"); then
        ok "审批后产出" "artifact.created"
        if evwait "$rid" "event: run.finished" "$W_FINISH" >/dev/null; then
          ok "run 正常收尾" "run.finished"
        else
          no "run 正常收尾" "$(echo "$ev2" | grep '^event:' | tr '\n' ' ' | head -c 160)"
        fi
      else
        no "审批后产出" "$(echo "$ev2" | grep '^event:' | tr '\n' ' ' | head -c 160)"
      fi
    else
      no "审批暂停" "$(echo "$ev" | grep '^event:' | tr '\n' ' ' | head -c 160)"
    fi
    curl -s -o /dev/null -m 20 -b "$JAR" -H "Authorization: Bearer $T_A" -X POST "$BASE/api/runs/$rid/cancel" || true
  else
    no "创建 run" "$body"
  fi
else
  sk "① 真实模型" "未配置 MODEL_*，放行见 HANDOFF.md ①（$(echo "$ms" | head -c 48)）"
fi

# 调试/自检用：只跑 ① 就收尾（给 check-arbiter-bites.sh 用，几秒出结果）
if [ "${ACCEPT_ONLY:-}" = "1" ]; then
  echo
  echo "== 汇总：pass=$pass fail=$fail skip=$skip"
  [ "$fail" -eq 0 ] || exit 1
  exit 0
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

# 验收自己收尾：r3 等仍在等审批的 run 必须取消，否则每次验收都留下僵尸（cancel 幂等）
for r in $r1 $r2 $r3; do
  [ -n "$r" ] && curl -s -o /dev/null -m 20 -b "$JAR" -H "Authorization: Bearer $T_A" -X POST "$BASE/api/runs/$r/cancel" || true
done

echo "== ③ 访问控制与限流"
[ "$(code "$BASE/")" = 302 ] && ok "未登录首页" "302" || no "未登录首页" "期望 302"
[ "$(code "$BASE/api/sessions")" = 401 ] && ok "未登录 API" "401" || no "未登录 API" "期望 401"
[ "$(code -b "$JAR" "$BASE/")" = 200 ] && ok "已登录首页" "200" || no "已登录首页" "期望 200"
# Cookie 会话必须能直接调用 API（"登录后页面可用"的关键；只看 curl 会漏掉）
me_cookie=$(code -b "$JAR" "$BASE/api/me")
[ "$me_cookie" = 200 ] && ok "Cookie 直接调 API" "200（无需 Bearer）" || no "Cookie 直接调 API" "期望 200，实际 $me_cookie"

# 总览 API 必须与页面同租户可用（概览页依赖它）
ov=$(curl -s -m 20 -b "$JAR" "$BASE/api/overview")
echo "$ov" | grep -q '"tenantId"' && ok "总览 API" "200 且含 tenantId" || no "总览 API" "响应异常：$(echo "$ov" | head -c 60)"

# 会话级状态接口（审批还原 / 授权 / 产物 / 续接）——刷新后界面靠这四个接口说真话
SID_PROBE=$(cut -d= -f2- "$TOK_FILE" 2>/dev/null | head -1 >/dev/null; echo s_a1)
all_ok=1
for ep in pending grants artifacts active; do
  c=$(code -b "$JAR" -H "Authorization: Bearer $T_A" "$BASE/api/sessions/$SID_PROBE/$ep")
  [ "$c" = 200 ] || { all_ok=0; echo "  … /$ep 返回 $c"; }
done
[ "$all_ok" = 1 ] && ok "会话级状态接口" "pending/grants/artifacts/active 均 200" || no "会话级状态接口" "有端点未返回 200"

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
