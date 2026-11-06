import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTools } from '../src/tools.mjs'

function setup(t) {
  const root = join(tmpdir(), `tools-read-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, tools: createTools({ workspaceRoot: root }), runId: 'r_read' }
}

test('fs.read 缺文件 → file_not_found，且报错里不含宿主机路径', async (t) => {
  const { root, tools, runId } = setup(t)
  await assert.rejects(
    () => tools.run('fs.read', { path: 'nope.md' }, runId),
    (e) => {
      assert.match(String(e.message), /^file_not_found: nope\.md/)
      assert.ok(!String(e.message).includes(root), `错误里泄漏了宿主机路径：${e.message}`)
      return true
    },
  )
})

test('fs.read 读到目录 → is_a_directory（同样是干净消息）', async (t) => {
  const { root, tools, runId } = setup(t)
  mkdirSync(join(root, runId, 'dir'), { recursive: true })
  await assert.rejects(
    () => tools.run('fs.read', { path: 'dir' }, runId),
    /is_a_directory|file_not_found/,
  )
})

test('fs.write 支持多级目录（真实模型常写 reports/x.md）', async (t) => {
  const { root, tools, runId } = setup(t)
  const out = await tools.run('fs.write', { path: 'reports/2026/q4.md', content: 'hi' }, runId)
  assert.equal(out.artifact.path, 'reports/2026/q4.md')
  const read = await tools.run('fs.read', { path: 'reports/2026/q4.md' }, runId)
  assert.equal(read.content, 'hi')
})
