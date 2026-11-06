#!/usr/bin/env bash
# 文档体检：让文档里的数字与命令跟着代码走，而不是靠人记得改。
#   1) HANDOFF / VERIFICATION 里写的 pass=N 必须等于 acceptance 实际结果
#   2) 文档里提到的 scripts/*.sh|mjs 必须真实存在且可执行
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${BASE:-http://127.0.0.1:8787}"
FROM=""   # --from "pass=19 fail=0 skip=2"：跳过跑验收，直接用给定值（便于自测）
pass=0; fail=0
ok(){ printf '  ✔ %-28s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-28s %s\n' "$1" "$2"; fail=$((fail+1)); }

echo "== 1) 文档里的验收数字标记与实测一致"
FROMVAL=""
while [ $# -gt 0 ]; do case "$1" in --from) FROMVAL="$2"; FROM=1; shift 2 ;; *) shift ;; esac; done
if [ -n "$FROM" ]; then
  actual=$(printf '%s' "$FROMVAL")
else
  OUT=$(./scripts/acceptance.sh "$BASE" 2>/dev/null)
  actual=$(printf '%s\n' "$OUT" | sed -n 's/^== 汇总：pass=\([0-9]*\) fail=\([0-9]*\) skip=\([0-9]*\)$/\1 \2 \3/p' | tail -1)
fi
[ -n "$actual" ] || { no "实测汇总" "acceptance 未输出汇总"; exit 1; }
# 统一成 "pass fail skip" 三个数字（--from 传的是带标签的串）
actual=$(printf '%s' "$actual" | sed -E 's/.*pass=([0-9]+) fail=([0-9]+) skip=([0-9]+).*/\1 \2 \3/')
set -- $actual; ap=$1; af=$2; as=$3
if [ "$af" != 0 ]; then
  ok "跳过文档比对" "验收本身失败（fail=$af），先修系统再比文档"
else
  ok "实测汇总" "pass=$ap fail=$af skip=$as"
  for doc in HANDOFF.md VERIFICATION.md; do
    [ -f "$doc" ] || continue
    marker=$(grep -oE '<!-- acceptance: pass=[0-9]+ fail=[0-9]+ skip=[0-9]+ -->' "$doc" | head -1)
    if [ -z "$marker" ]; then no "$doc 标记" "缺少 <!-- acceptance: pass=.. fail=.. skip=.. -->"; continue; fi
    want=$(printf '%s' "$marker" | sed -E 's/.*pass=([0-9]+) fail=([0-9]+) skip=([0-9]+).*/\1 \2 \3/')
    if [ "$want" = "$actual" ]; then ok "$doc 标记" "pass=$ap fail=$af skip=$as"
    else no "$doc 标记" "写的是 $want，实际是 $actual"; fi
  done
fi

echo "== 2) 文档引用的脚本真实存在"
for doc in HANDOFF.md VERIFICATION.md README.md RUNBOOK.md SECURITY.md; do
  [ -f "$doc" ] || continue
  miss=""
  for f in $(grep -oE 'scripts/[A-Za-z0-9_.-]+\.(sh|mjs)' "$doc" | sort -u); do
    [ -f "$f" ] || miss="$miss $f"
  done
  [ -z "$miss" ] && ok "$doc 引用的脚本" "全部存在" || no "$doc 引用的脚本" "缺失:$miss"
done

# 测试文件数：文档里的标记必须与实际一致（防止"加了测试但交接文档没更新"）
actual_files=$(ls impl/test/*.test.mjs 2>/dev/null | wc -l | tr -d ' ')
declared=$(grep -o '<!-- test-files: [0-9]* -->' HANDOFF.md 2>/dev/null | grep -o '[0-9]*' | head -1)
if [ -n "${declared:-}" ]; then
  if [ "$declared" = "$actual_files" ]; then
    ok "HANDOFF 测试文件数" "$actual_files"
  else
    no "HANDOFF 测试文件数" "文档=$declared 实际=$actual_files"
  fi
else
  skip "HANDOFF 测试文件数" "缺少 <!-- test-files: N --> 标记"
fi

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
