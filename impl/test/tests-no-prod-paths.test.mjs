import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// 真实事故（v268）：CF 分支的自检用例跑完后，把假 token 写进了 /etc/cube-agent/cf.env。
// 教训不是"小心点"，而是**用一条检查禁止测试引用生产路径**。
// 需要这些路径时，脚本必须提供覆盖项（UNBLOCK_* / CF_API_BASE / DB_PATH 等）。
const PROD_PATHS = ['/etc/cube-agent', '/var/lib/cube-agent', '/var/backups/cube-agent']

test('测试文件里不得出现生产路径（防止测试写进生产）', () => {
  const offenders = []
  for (const f of readdirSync('impl/test')) {
    if (!f.endsWith('.mjs') || f === 'tests-no-prod-paths.test.mjs') continue
    const src = readFileSync(`impl/test/${f}`, 'utf8')
    for (const p of PROD_PATHS) {
      if (src.includes(p)) offenders.push(`${f} → ${p}`)
    }
  }
  assert.deepEqual(offenders, [], `测试不许引用生产路径（改用临时目录或脚本的覆盖项）：\n${offenders.join('\n')}`)
})
