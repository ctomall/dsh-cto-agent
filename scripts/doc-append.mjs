#!/usr/bin/env node
// 往回流文档插入一段内容，并且**插入后自检**：
//   锚点必须唯一命中；插入后必须能在文件里找到新增内容的指纹行。
// 目的：防止"补丁没打上、记录却已经写了"（v138 真实事故）。
// 用法：
//   node scripts/doc-append.mjs --file <path> --after "<锚点子串>" --text <path> [--marker "<指纹子串>"]
import { readFileSync, writeFileSync } from 'node:fs'

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

const lines = readFileSync(file, 'utf8').split('\n')
const hits = lines.map((l, i) => (l.includes(after) ? i : -1)).filter((i) => i >= 0)
if (hits.length !== 1) {
  console.error(`FAIL: 锚点命中 ${hits.length} 处（必须恰好 1 处）：${after}`)
  process.exit(3)
}

const block = readFileSync(textPath, 'utf8').replace(/\s+$/, '')
lines.splice(hits[0] + 1, 0, block)
const out = lines.join('\n')
writeFileSync(file, out)

// 自检：指纹默认取插入块里最长的一行的前 24 个字符
const marker = get('marker') ?? block.split('\n').filter((l) => l.trim()).sort((a, b) => b.length - a.length)[0]?.slice(0, 24)
if (!marker) {
  console.error('FAIL: 插入内容为空，无法自检')
  process.exit(4)
}
if (!readFileSync(file, 'utf8').includes(marker)) {
  console.error(`FAIL: 插入后找不到指纹「${marker}」，补丁未生效`)
  process.exit(5)
}
console.log(`OK: 已插入（锚点行 ${hits[0] + 1}，指纹「${marker}」）`)
