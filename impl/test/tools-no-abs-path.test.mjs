import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTools } from '../src/tools.mjs'

// 工具回给模型/用户的文案不能带宿主机绝对路径（会进对话、日志、审计）。
test('fs.write 成功文案只用会话内相对路径', async (t) => {
  const root = join(tmpdir(), `noabs-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tools = createTools({ workspaceRoot: root })
  const out = await tools.run('fs.write', { path: 'reports/q4.md', content: 'hi' }, 'r_x')
  assert.equal(out.content, '已写入 reports/q4.md')
  assert.ok(!out.content.includes(root), `文案里泄漏了宿主机路径：${out.content}`)
  assert.ok(!out.content.includes('/tmp/'), `文案里出现了绝对路径：${out.content}`)
})
