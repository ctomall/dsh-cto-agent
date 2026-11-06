import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ② 的 UI 承诺："本会话允许"必须真的发 allow_session（否则就是"本会话允许 == 允许一次"的虚假承诺）。
// 这条此前没有任何自动检查：把 sess 按钮改成 decide('allow_once')，267 条测试全绿（v209 实测）。
const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')

const decisionFor = (varName) => {
  const re = new RegExp(`${varName}\\.addEventListener\\('click', \\(\\) => decide\\('([^']+)'\\)\\)`)
  const m = src.match(re)
  return m?.[1] ?? null
}

test('审批三按钮各自发对的决定：允许一次 / 本会话允许 / 拒绝', () => {
  assert.equal(decisionFor('once'), 'allow_once', '「允许一次」按钮必须发 allow_once')
  assert.equal(decisionFor('sess'), 'allow_session', '「本会话允许」按钮必须发 allow_session（不能退化成允许一次）')
  assert.equal(decisionFor('deny'), 'deny', '「拒绝」按钮必须发 deny')
})

test('两种允许的文案必须可区分（不能都写成"已允许"）', () => {
  const line = src.split('\n').find((l) => l.includes('const DECISION_TEXT'))
  assert.ok(line, '未找到 DECISION_TEXT')
  assert.match(line, /allow_once: '已允许一次'/)
  assert.match(line, /allow_session: '已允许本会话'/)
})
