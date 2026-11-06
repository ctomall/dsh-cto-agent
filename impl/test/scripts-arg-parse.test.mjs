import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// 防回归：同时"接受 --flag"和"把 $1 当位置参数"的脚本，会在 flag 先出现时把 flag 当成端口/地址。
// 真实案例：restore-drill.sh --from-latest → PORT="--from-latest" → validatePort 崩。
test('脚本不得同时解析 --flag 且把 $1 直接当位置参数', () => {
  const dir = 'scripts'
  const offenders = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sh')) continue
    const src = readFileSync(`${dir}/${f}`, 'utf8')
    const takesFlags = /case "\$a" in|--[a-z-]+\)/.test(src) || /\$@/.test(src) && /--[a-z-]+/.test(src)
    // 只看**顶层**位置参数（行首变量赋值），函数里的 local x="$1" 不算
    const usesDollar1 = /^[A-Z_][A-Z0-9_]*=\s*"?\$\{1[:}]/m.test(src) || /^[A-Z_][A-Z0-9_]*=\s*"\$1"/m.test(src)
    if (takesFlags && usesDollar1) offenders.push(f)
  }
  assert.deepEqual(offenders, [], `这些脚本可能把 flag 当位置参数：${offenders.join(', ')}`)
})
