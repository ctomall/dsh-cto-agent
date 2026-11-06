#!/usr/bin/env node
// 对比度自检：按 WCAG AA 校验关键前景/背景组合（正文 4.5:1，大字 3:1）。
// 令牌直接读 impl/web/app.css，避免"改了色没改文档"。
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../impl/web/app.css', import.meta.url), 'utf8')
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8}|rgba?\\([^)]+\\))`).exec(css)
  return m ? m[1] : null
}
const hex = (c) => {
  if (c.startsWith('#')) {
    let h = c.slice(1)
    if (h.length === 3) h = h.split('').map((x) => x + x).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const m = /rgba?\(([^)]+)\)/.exec(c)
  const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}
const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
const ratio = (fg, bg) => {
  const l1 = lum(hex(fg)), l2 = lum(hex(bg))
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (a + 0.05) / (b + 0.05)
}

// DSH 令牌命名：--n00/--n55/--n500/--n700/--n1000、--blue500
const T = { ink: token('n1000'), ink2: token('n700'), meta: token('ink-meta'), bg: token('n55'), surface: token('n00'), btn: token('blue600') }
const pairs = [
  ['正文 n1000 / 白卡', T.ink, T.surface, 4.5],
  ['正文 n1000 / 页面底', T.ink, T.bg, 4.5],
  ['次要 n700 / 白卡', T.ink2, T.surface, 4.5],
  ['次要 n700 / 页面底', T.ink2, T.bg, 4.5],
  ['元信息 ink-meta / 白卡', T.meta, T.surface, 4.5],
  ['元信息 ink-meta / 页面底', T.meta, T.bg, 4.5],
  ['主按钮白字 / blue600', '#ffffff', T.btn, 4.5],
]

let fail = 0
console.log('== WCAG AA 对比度')
for (const [label, fg, bg, need] of pairs) {
  if (!fg || !bg) { console.log(`  ? ${label}: 令牌缺失`); fail++; continue }
  const r = ratio(fg, bg)
  const okv = r >= need
  if (!okv) fail++
  console.log(`  ${okv ? '✔' : '✖'} ${label.padEnd(34)} ${r.toFixed(2)}:1（需 ≥${need}）`)
}
console.log(fail ? `== ${fail} 项不达标` : '== 全部达标')
process.exit(fail ? 1 : 0)
