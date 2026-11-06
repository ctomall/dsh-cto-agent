import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// 真实教训（v250）：cf-access-setup.sh 把 policy / ratelimit 的响应丢进 /dev/null，
// 失败时照样打印"已创建"。**会改变系统状态的命令，不允许静默丢弃输出。**
// 允许的例外：行尾注明 `# ok-discard`（表示后续有独立断言兜底）。
const MUTATORS = [/(^|\s)curl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|-d\s|--data)/, /(^|\s)git\s+(reset|checkout|pull|push|clean)/, /(^|\s)systemctl\s+(start|stop|restart|enable)/, /(^|\s)(rm|mv|cp)\s+-/]

test('脚本里"改状态"的命令不得静默丢弃输出（>/dev/null 或 2>/dev/null）', () => {
  const offenders = []
  for (const f of readdirSync('scripts')) {
    if (!f.endsWith('.sh')) continue
    const lines = readFileSync(`scripts/${f}`, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('ok-discard') || line.trimStart().startsWith('#')) return
      // 收尾/清理是"尽力而为"的：失败无所谓，不该按这个规则要求它报错
      if (/\bcleanup\b|\btrap\b|\bkill\b/.test(line)) return
      if (!/>\s*\/dev\/null/.test(line)) return
      if (!MUTATORS.some((re) => re.test(line))) return
      offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`)
    })
  }
  assert.deepEqual(offenders, [], `这些命令失败时不会被发现：\n${offenders.join('\n')}`)
})
