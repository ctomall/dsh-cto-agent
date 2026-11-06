import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 防回归：源码里不许再出现"占位式伪路径"（会被人当成真实路径）
test('实现代码里不出现 /data/tenants 这类占位路径', () => {
  const dirs = ['impl/src', 'impl/web']
  const bad = []
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!/\.(mjs|js|html)$/.test(f)) continue
      const src = readFileSync(join(dir, f), 'utf8')
      if (src.includes('/data/tenants')) bad.push(`${dir}/${f}`)
    }
  }
  assert.deepEqual(bad, [], `这些文件里还有占位路径：${bad.join(', ')}`)
})
