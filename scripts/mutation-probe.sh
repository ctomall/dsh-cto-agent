#!/usr/bin/env bash
# 变异探针：故意改坏一处实现，确认测试会红——证明这套测试真的在管事，而不是全绿摆设。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pass=0 fail=0
ok(){ printf '  ✔ %-34s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-34s %s\n' "$1" "$2"; fail=$((fail+1)); }

probe() { # name file patch_py tests...
  local name="$1" file="$2" patch="$3"; shift 3
  local tests=("$@")
  cp "$file" "$file.mutbak"
  python3 -c "$patch" "$file"
  local out rc
  out=$(timeout 200 node --test --test-timeout=25000 "${tests[@]}" 2>&1); rc=$?
  mv "$file.mutbak" "$file"
  if [ "$rc" -ne 0 ]; then ok "$name" "测试变红（有效）"; else no "$name" "测试仍全绿（该用例无效）"; fi
}

# 已验证（2026-11-06，手动单点执行）：
#   去掉 SSE 租户校验      → tenant-isolation 失败 2 条（跨租户读事件流 / 资源×租户矩阵）
#   关掉工具结果幂等缓存   → idempotency 失败 1 条（第二次应走缓存并标 replayed）
# 注意：把「审批门」整体关掉会让依赖挂起的用例长时间等待，单次跑会拖到分钟级，故默认不纳入。

echo "== 变异探针"
probe "去掉 SSE 租户校验" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='if (!evOwner || evOwner.tenant_id !== ctx.tenantId)'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'if (false)',1))
" impl/test/tenant-isolation.test.mjs impl/test/tenant-matrix.test.mjs

probe "审批门失效（confirm 当 auto 跑）" impl/src/loop.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"if (policy === 'confirm') {\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,\"if (false) {\",1))
" impl/test/loop-driver-driven.test.mjs impl/test/pending-resume.test.mjs

probe "关掉工具结果幂等缓存" impl/src/loop.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='const cached = this.toolResults?.get(runId, callId)'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'const cached = null',1))
" impl/test/idempotency.test.mjs

probe "会话授权不再生效" impl/src/loop.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='this.grants?.has({ tenantId, sessionId, tool: call.name })'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'false',1))
" impl/test/grants-isolation.test.mjs

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
