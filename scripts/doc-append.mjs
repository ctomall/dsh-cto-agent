#!/usr/bin/env node
// 往回流文档插入一段内容，并且**插入后自检**：
//   锚点必须唯一命中；插入后必须能在文件里找到新增内容的指纹行。
// 目的：防止"补丁没打上、记录却已经写了"（v138 / v158 两次真实事故）。
// 用法：
//   node scripts/doc-append.mjs --file <path> --after "<锚点子串>" --text <path> [--marker "<指纹子串>"]
import { readFileSync, writeFileSync } from 'node:fs'

export function appendToDoc({ file, after, text, marker }) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const hits = lines.map((l, i) => (l.includes(after) ? i : -1)).filter((i) => i >= 0)
  if (hits.length !== 1) throw new Error(`锚点命中 ${hits.length} 处（必须恰好 1 处）：${after}`)
  const block = readFileSync(text, 'utf8').replace(/\s+$/, '')
  if (!block.trim()) throw new Error('插入内容为空，无法自检')
  lines.splice(hits[0] + 1, 0, block)
  writeFileSync(file, lines.join('\n'))
  const fp = marker ?? block.split('\n').filter((l) => l.trim()).sort((a, b) => b.length - a.length)[0]?.slice(0, 24)
  if (!fp) throw new Error('插入内容为空，无法自检')
  if (!readFileSync(file, 'utf8').includes(fp)) throw new Error(`插入后找不到指纹「${fp}」，补丁未生效`)
  return { line: hits[0] + 1, marker: fp }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const get = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const file = get('file')
  const after = get('after')
  const textPath = get('text')
  if (!file || !after || !textPath) {
    console.error('用法: --file <path> --after "<锚点子串>" --text <path> [--marker "<指纹>"]')
    process.exit(2)
  }
  try {
    const r = appendToDoc({ file, after, text: textPath, marker: get('marker') })
    console.log(`OK: 已插入（锚点行 ${r.line}，指纹「${r.marker}」）`)
  } catch (e) {
    const msg = String(e.message)
    console.error('FAIL: ' + msg)
    process.exit(msg.includes('锚点') ? 3 : msg.includes('为空') ? 4 : 5)
  }
}
