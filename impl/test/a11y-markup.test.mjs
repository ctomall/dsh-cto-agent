import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 静态断言：无障碍语义不能被后续改版悄悄删掉
const html = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8')

for (const file of ['index.html', 'overview.html', 'artifacts.html', 'settings.html']) {
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

test('429 有统一人话（不能让用户看到泛化的「失败」）', () => {
  const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  const sjs = readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8')
  assert.match(js, /function rateLimitedText/, '要有统一的限流文案函数')
  assert.match(js, /retry-after/, '要读取 retry-after')
  assert.match(js, /过于频繁/, '文案要说明是限流')
  assert.match(sjs, /过于频繁/, '探针也要有 429 文案')
})

test('页面脚本都必须有 fetch 超时（公网丢包不能把页面卡死）', () => {
  for (const f of ['app.js', 'overview.js', 'artifacts.js', 'settings.js']) {
    const js = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8')
    assert.match(js, /FETCH_TIMEOUT_MS/, `${f} 缺少超时常量`)
    assert.match(js, /function fetchT|const fetchT/, `${f} 缺少 fetchT 包装`)
    // 不允许再出现"裸 fetch"（除 fetchT 自身内部那一处）
    const bare = js.split('\n').filter((l) => /\bfetch\(/.test(l) && !/return await fetch\(path/.test(l))
    assert.equal(bare.length, 0, `${f} 仍有裸 fetch：\n${bare.join('\n')}`)
  }
})

test('审批卡必须说明"参数被截断"（不能让人以为模型只写了这么多）', () => {
  const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  assert.match(js, /argsTruncated/, 'app.js 未处理 argsTruncated')
  assert.match(js, /已截断显示/, '缺少截断提示文案')
})
