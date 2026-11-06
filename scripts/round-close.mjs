#!/usr/bin/env node
// 回合收口的硬约束：**文档补丁先落地并自检通过，才允许写投递记录**。
// 背景：v138 与 v158 两次「记录先写、补丁没打」，都是靠自觉才发现。
// 用法：
//   node scripts/round-close.mjs --doc <vN.md> --after "<锚点>" --chunk <片段.md> --record <记录.json>
import { readFileSync, appendFileSync } from 'node:fs'
import { appendToDoc } from './doc-append.mjs'

const args = process.argv.slice(2)
const get = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const doc = get('doc'), after = get('after'), chunk = get('chunk'), record = get('record')
if (!doc || !after || !chunk || !record) {
  console.error('用法: --doc <vN.md> --after "<锚点>" --chunk <片段.md> --record <记录.json>')
  process.exit(2)
}

let applied
try {
  applied = appendToDoc({ file: doc, after, text: chunk })
} catch (e) {
  console.error(`FAIL: 文档补丁未落地，拒绝写记录 —— ${e.message}`)
  process.exit(3)
}

let rec
try {
  rec = JSON.parse(readFileSync(record, 'utf8'))
} catch (e) {
  console.error(`FAIL: 记录不是合法 JSON —— ${e.message}（文档已更新：${doc}）`)
  process.exit(4)
}
rec.doc_verified = applied.marker
rec.doc_file = doc
rec.doc_line = applied.line
appendFileSync(rec.record_path ?? process.env.PUA_FEEDBACK_PATH ?? `${process.env.HOME}/.pua/feedback.jsonl`, JSON.stringify(rec, null, 0) + '\n')
console.log(`OK: 文档已插入（行 ${applied.line}，指纹「${applied.marker}」）→ 记录已追加`)
