#!/usr/bin/env bash
# 目标约束自查：「密钥不入库」。
# 1) 运行期密钥文件必须被忽略且未被跟踪；2) 受控文件里不得出现真实密钥值；3) 提交历史里也不得出现。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pass=0; fail=0
ok(){ printf '  ✔ %-30s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-30s %s\n' "$1" "$2"; fail=$((fail+1)); }

echo "== 1) 运行期密钥文件"
for f in .runtime-tokens .runtime-app-password; do
  if [ -f "$f" ]; then
    if git check-ignore -q "$f"; then ok "$f 已被忽略" "gitignore"; else no "$f 未被忽略" "会进仓库"; fi
    if [ -z "$(git ls-files --error-unmatch "$f" 2>/dev/null)" ]; then ok "$f 未被跟踪" "untracked"; else no "$f 已被跟踪" "立刻 remove --cached"; fi
  else
    ok "$f 不存在" "跳过"
  fi
done

echo "== 2) 受控文件中的敏感模式"
patterns='sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}'
hits=$(git grep -nEI "$patterns" -- . ':!scripts/secret-scan.sh' 2>/dev/null | head -5)
[ -z "$hits" ] && ok "受控文件无密钥模式" "0 命中" || { no "受控文件出现密钥模式" "$(echo "$hits" | head -2 | tr '\n' ' ')"; }

echo "== 3) 当前真实密钥值是否出现在受控文件/历史"
vals=()
[ -f .runtime-app-password ] && vals+=("$(cut -d= -f2- .runtime-app-password)")
[ -f .runtime-tokens ] && while IFS= read -r line; do vals+=("$(printf '%s' "$line" | cut -d= -f2-)"); done < .runtime-tokens
found=0
for v in "${vals[@]}"; do
  [ ${#v} -lt 16 ] && continue
  if git grep -qF -- "$v" -- . 2>/dev/null; then no "工作区出现真实密钥值" "长度 ${#v}"; found=1; fi
  if git log --all -p --no-color 2>/dev/null | grep -qF -- "$v"; then no "提交历史出现真实密钥值" "长度 ${#v}"; found=1; fi
done
[ "$found" = 0 ] && ok "真实密钥值未入库" "工作区与历史均 0 命中"

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
