#!/usr/bin/env node
// 生成 scripts/README.md：每个脚本一行用途（取脚本自己的首行注释）。
// 目的：让"脚本清单"可以从代码自动重建，而不是靠人记得更新。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = new URL('.', import.meta.url).pathname
const files = readdirSync(dir).filter((f) => /\.(sh|mjs)$/.test(f) && f !== 'gen-scripts-index.mjs').sort()

const descOf = (file) => {
  const src = readFileSync(join(dir, file), 'utf8')
  const lines = src.split('\n')
  // 跳过 shebang / 首行 "#!/usr/bin/env node"
  for (const line of lines.slice(0, 6)) {
    const m = line.match(/^#\s*(.+)$/) ?? line.match(/^\/\/\s*(.+)$/)
    if (!m) continue
    const text = m[1].trim()
    if (/^!/.test(text)) continue // shebang 的残留
    if (text.length >= 4) return text.slice(0, 120)
  }
  return '（无说明）'
}

const rows = files.map((f) => `| \`${f}\` | ${descOf(f).replace(/\|/g, '\\|')} |`)
const out = `# scripts 索引（自动生成）

> 由 \`node scripts/gen-scripts-index.mjs\` 生成，**不要手改**。
> \`docs-check\` 会校验：这里列出的脚本必须与目录里的一致（防止"脚本加了但没人知道"）。

| 脚本 | 用途 |
|---|---|
${rows.join('\n')}
`
writeFileSync(join(dir, 'README.md'), out)
console.log(`OK: 已生成 scripts/README.md（${files.length} 个脚本）`)
