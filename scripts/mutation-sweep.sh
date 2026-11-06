#!/usr/bin/env bash
# 变异批量扫描：逐条改坏实现 → 跑全量测试 → 记录"是否变红" → 还原。
# 与 mutation-probe.sh 的区别：探针跑指定的少数用例（快），本脚本跑**全量**（慢，约 7 分钟/7 项）。
# 判定：OK = 改坏后测试变红（说明有守）；INEFFECTIVE = 测试仍全绿（说明这项没人守）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ok=0; bad=0
run_mut() { # name file python_patch
  local name="$1" file="$2" patch="$3"
  cp "$file" /tmp/msw.bak
  if ! python3 -c "$patch" "$file"; then
    echo "PATCHFAIL $name"; cp /tmp/msw.bak "$file"; bad=$((bad+1)); return
  fi
  timeout -k 10 400 node --test --test-force-exit --test-concurrency=6 --test-timeout=30000 impl/test/*.test.mjs >/tmp/msw.out 2>&1
  local rc=$?
  cp /tmp/msw.bak "$file"; rm -f /tmp/msw.bak
  if [ $rc -eq 0 ]; then echo "INEFFECTIVE $name"; bad=$((bad+1)); else echo "OK $name"; ok=$((ok+1)); fi
}

run_mut "终态不写 ended_at" impl/src/runs.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"this.db.prepare('update runs set status = ?, ended_at = ? where id = ?').run(to, new Date().toISOString(), runId)\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,\"this.db.prepare('update runs set status = ? where id = ?').run(to, runId)\",1))
"

run_mut "去掉全局并发上限" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='if (Number(running) >= maxConcurrent) {'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'if (false) {',1))
"

run_mut "去掉审批快照 TTL" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"for (const p of db.prepare('select run_id from run_pending where created_at < ?').all(cutoff)) {\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'for (const p of []) {',1))
"

run_mut "产物事件补发失效" impl/src/loop.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='if (cached.artifact && this.artifactExists && !this.artifactExists(runId, cached.artifact.path)) {'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'if (false) {',1))
"

run_mut "产物事件补发不去重" impl/src/loop.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='if (cached.artifact && this.artifactExists && !this.artifactExists(runId, cached.artifact.path)) {'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'if (cached.artifact) {',1))
"

run_mut "事件序号回到先算再写" impl/src/events.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
i=s.index('  append(runId, type, payload = {}) {'); j=s.index('  // afterSeq')
old='''  append(runId, type, payload = {}) {
    const seq = this.nextSeq(runId)
    this.db
      .prepare('insert into events (run_id, seq, type, payload_json, ts) values (?, ?, ?, ?, ?)')
      .run(runId, seq, type, JSON.stringify(payload), new Date().toISOString())
    return seq
  }

'''
io.open(p,'w',encoding='utf-8').write(s[:i]+old+s[j:])
"

run_mut "升级回滚失效" impl/src/upgrade.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"await run(['reset', '--hard', before]).catch(() => {})\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'',1))
"

run_mut "产物列表忽略租户过滤" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"where e.type = 'artifact.created' and r.tenant_id = ?\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,\"where e.type = 'artifact.created' and (r.tenant_id = ? or 1=1)\",1))
"

run_mut "会话列表忽略租户过滤" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"prepare('select id, title from sessions where tenant_id = ? order by id')\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,\"prepare('select id, title from sessions where (tenant_id = ? or 1=1) order by id')\",1))
"

run_mut "限流窗口永不生效" impl/src/ratelimit.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old='const live = prev.filter((t) => now - t < windowMs)'
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,'const live = []',1))
"

run_mut "把 /api/sessions 加进公开集" impl/src/server.mjs "
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
old=\"|| url.pathname === '/healthz'\"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,\"|| url.pathname === '/healthz' || url.pathname === '/api/sessions'\",1))
"

echo "== 汇总：有效(变红)=$ok 无效(仍绿)=$bad"
[ "$bad" -eq 0 ] || exit 1
