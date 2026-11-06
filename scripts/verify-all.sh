#!/usr/bin/env bash
# 一条命令跑完所有可自动验证的证据，并给出统一结论。
# 约定：SKIP 不算失败（外部凭据未配置），但会被明确列出；真正的失败才退非零。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:-http://127.0.0.1:8787}"
pass=0 fail=0 skip=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }
sk(){ printf '  ○ %-30s %s\n' "$1" "$2"; skip=$((skip+1)); }

echo "== 1) 全量测试"
out=$(timeout 300 node --test --test-timeout=30000 impl/test/*.test.mjs 2>&1)
t=$(printf '%s\n' "$out" | sed -n 's/^ℹ tests \([0-9]*\)$/\1/p' | tail -1)
p=$(printf '%s\n' "$out" | sed -n 's/^ℹ pass \([0-9]*\)$/\1/p' | tail -1)
f=$(printf '%s\n' "$out" | sed -n 's/^ℹ fail \([0-9]*\)$/\1/p' | tail -1)
[ "${f:-1}" = 0 ] && ok "node --test" "${p:-0}/${t:-0} 通过" || no "node --test" "fail=${f:-?}"

echo "== 2) 密钥不入库"
if ./scripts/secret-scan.sh >/tmp/vs.log 2>&1; then ok "secret-scan" "$(tail -1 /tmp/vs.log)"; else no "secret-scan" "$(tail -1 /tmp/vs.log)"; fi

echo "== 3) 对比度 AA"
if node scripts/a11y-contrast.mjs >/tmp/vc.log 2>&1; then ok "a11y-contrast" "$(tail -1 /tmp/vc.log)"; else no "a11y-contrast" "$(tail -1 /tmp/vc.log)"; fi

echo "== 4) 限流（临时实例）"
if ./scripts/ratelimit-check.sh >/tmp/vr.log 2>&1; then ok "ratelimit-check" "$(grep -E '汇总' /tmp/vr.log | tail -1)"; else no "ratelimit-check" "$(grep -E '汇总|✖' /tmp/vr.log | tail -1)"; fi

echo "== 5) 目标验收（含 SKIP 统计）"
./scripts/acceptance.sh --require-all "$BASE" >/tmp/va.log 2>&1
code=$?
sum=$(grep -E '^== 汇总' /tmp/va.log | tail -1)
case "$code" in
  0) ok "acceptance" "$sum" ;;
  3) sk "acceptance" "$sum（有 SKIP，见 HANDOFF）" ;;
  *) no "acceptance" "$sum（exit=$code）" ;;
esac

echo "== 6) 文档与实测一致"
acc=$(sed -n 's/^== 汇总：pass=\([0-9]*\) fail=\([0-9]*\) skip=\([0-9]*\)$/\1 \2 \3/p' /tmp/va.log | tail -1)
if [ -n "$acc" ]; then
  set -- $acc
  if ./scripts/docs-check.sh --from "pass=$1 fail=$2 skip=$3" >/tmp/vd.log 2>&1; then
    ok "docs-check" "$(grep -E '^== 汇总' /tmp/vd.log | tail -1)"
  else
    no "docs-check" "$(grep -E '✖' /tmp/vd.log | head -2 | tr '\n' ' ')"
  fi
else
  sk "docs-check" "没有验收汇总可比对"
fi

echo "== 7) 密钥是否外泄到日志/数据库"
if ./scripts/secret-leak-scan.sh >/tmp/vl.log 2>&1; then
  ok "secret-leak-scan" "$(grep -E '^== 汇总' /tmp/vl.log | tail -1)"
else
  no "secret-leak-scan" "$(grep -E '✖' /tmp/vl.log | head -2 | tr '\n' ' ')"
fi

echo
echo "== 8) 浏览器级演练（需要 CDP :9222；没有则 SKIP）"
if curl -s -m 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  bfail=0
  for sc in 400 timeout steps; do
    out=$(SCENARIO=$sc timeout 140 node scripts/check-failure-reason.mjs 2>&1 | tail -1)
    echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 失败原因($sc) $out"; }
  done
  out=$(timeout 140 node scripts/check-no-dup-stream.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 不重复 $out"; }
  out=$(timeout 140 node scripts/check-approval-truncation.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 截断提示 $out"; }
  out=$(timeout 140 node scripts/check-boot-resilience.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 启动容错 $out"; }
  out=$(timeout 140 node scripts/check-session-ops.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 会话操作 $out"; }
  out=$(timeout 140 node scripts/check-boot-hang.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 启动不卡死 $out"; }
  out=$(timeout 140 node scripts/check-send-before-session.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 慢列表下发送 $out"; }
  out=$(timeout 140 node scripts/check-double-submit.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 防重复提交 $out"; }
  out=$(timeout 200 node scripts/check-slow-model-flow.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 慢模型端到端 $out"; }
  out=$(timeout 200 node scripts/check-streaming-deltas.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 流式渐进渲染 $out"; }
  out=$(timeout 160 node scripts/check-empty-answer-note.mjs 2>&1 | tail -1)
  echo "$out" | grep -q '"ok":true' || { bfail=$((bfail+1)); echo "  ✖ 空正文提示 $out"; }
  out=$(timeout 240 ./scripts/check-first-real-run.sh 2>&1 | tail -1)
  echo "$out" | grep -q 'first-real-run 可用' || { bfail=$((bfail+1)); echo "  ✖ 放行脚本自检 $out"; }
  out=$(timeout 120 ./scripts/check-arbiter-bites.sh 2>&1 | tail -1)
  echo "$out" | grep -q '验收器会咬人' || { bfail=$((bfail+1)); echo "  ✖ 验收器自检(红) $out"; }
  out=$(timeout 120 ./scripts/check-arbiter-bites.sh --positive 2>&1 | tail -1)
  echo "$out" | grep -q '判据可满足' || { bfail=$((bfail+1)); echo "  ✖ 验收器自检(绿) $out"; }
  if [ "$bfail" -eq 0 ]; then ok "浏览器级演练" "失败原因×3 / 不重复 / 截断提示 全绿"; else no "浏览器级演练" "$bfail 项失败"; fi
else
  skip "浏览器级演练" "无 CDP（:9222），跳过"
fi

echo "== 结论：pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ] || exit 1
[ "$skip" -eq 0 ] || { echo "  注意：仍有 $skip 项 SKIP（未配置外部凭据），目标未完成"; exit 3; }
