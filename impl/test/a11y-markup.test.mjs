import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 静态断言：无障碍语义不能被后续改版悄悄删掉
const html = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8')

for (const file of ['index.html', 'overview.html']) {
  test(`${file}：语言、主区域名称、状态播报、消息流播报`, () => {
    const s = html(file)
    assert.match(s, /<html lang="zh-CN">/, '必须有 lang')
    assert.match(s, /<title>[^<]+<\/title>/, '必须有 title')
    assert.match(s, /<main[^>]*aria-label=/, '主区域要有可访问名称')
    assert.match(s, /<nav/, '要有导航地标')
    const status = s.match(/<footer[^>]*class="statusbar"[^>]*>/)
    assert.ok(status, '状态栏存在')
    assert.match(status[0], /role="status"/)
    assert.match(status[0], /aria-live="polite"/)
    if (file === 'index.html') {
      const stream = s.match(/<section[^>]*id="stream"[^>]*>/)
      assert.ok(stream, '消息流存在')
      assert.match(stream[0], /aria-live="polite"/, '流式内容要能播报')
      assert.match(stream[0], /role="log"/, '消息流语义为 log')
    }
  })
}

test('纯图标按钮必须有 aria-label', () => {
  const s = html('index.html')
  const buttons = s.match(/<button[^>]*>/g) ?? []
  const iconOnly = buttons.filter((b) => /icon-btn/.test(b))
  assert.ok(iconOnly.length >= 2, '至少有两个图标按钮')
  for (const b of iconOnly) assert.match(b, /aria-label="[^"]+"/, `图标按钮缺少 aria-label: ${b}`)
})

test('状态栏展示真实驱动（模型未接上时不能装作在思考）', () => {
  const html2 = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  assert.match(html2, /id="sbDriver"/, '状态栏要有驱动指示元素')
  assert.match(js, /\/api\/model\/status/, 'boot 时必须查询驱动状态')
  assert.match(js, /演示驱动（未接模型）/, '未接模型时要有明确文案')
})
