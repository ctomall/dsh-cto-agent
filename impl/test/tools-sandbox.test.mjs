import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools } from '../src/tools.mjs'

function mkws(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'out-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  return { root, outside, tools: createTools({ workspaceRoot: root }) }
}

test('工作区内正常读写', async (t) => {
  const { tools } = mkws(t)
  await tools.run('fs.write', { path: 'a/b.md', content: 'hello' }, 'r1')
  const out = await tools.run('fs.read', { path: 'a/b.md' }, 'r1')
  assert.equal(out.content, 'hello')
})

test('"../" 逃逸被拒', async (t) => {
  const { tools } = mkws(t)
  await assert.rejects(() => tools.run('fs.write', { path: '../../etc/x', content: 'x' }, 'r1'), /path outside workspace/)
})

test('绝对路径被拒', async (t) => {
  const { tools } = mkws(t)
  await assert.rejects(() => tools.run('fs.write', { path: '/tmp/evil.txt', content: 'x' }, 'r1'), /path outside workspace/)
})

test('符号链接逃逸被拒（词法检查挡不住，realpath 能挡）', async (t) => {
  const { root, outside, tools } = mkws(t)
  mkdirSync(join(root, 'r1'), { recursive: true })
  symlinkSync(outside, join(root, 'r1', 'link'))
  await assert.rejects(() => tools.run('fs.write', { path: 'link/pwned.txt', content: 'x' }, 'r1'), /path outside workspace/)
  assert.equal(existsSync(join(outside, 'pwned.txt')), false, '外部目录不得被写入')
})

test('符号链接读取同样被拒', async (t) => {
  const { root, outside, tools } = mkws(t)
  mkdirSync(join(root, 'r1'), { recursive: true })
  symlinkSync(outside, join(root, 'r1', 'link'))
  await assert.rejects(() => tools.run('fs.read', { path: 'link/secret.txt' }, 'r1'), /path outside workspace|ENOENT/)
})

test('产物权限：目录 0700、文件 0600（同机其他用户不可读）', { skip: process.platform === 'win32' }, async (t) => {
  const { statSync } = await import('node:fs')
  const { root, tools } = mkws(t)
  await tools.run('fs.write', { path: 'secret/report.md', content: 'x' }, 'r1')
  const dirMode = statSync(join(root, 'r1', 'secret')).mode & 0o777
  const fileMode = statSync(join(root, 'r1', 'secret', 'report.md')).mode & 0o777
  assert.equal(dirMode, 0o700, `目录权限应为 700，实际 ${dirMode.toString(8)}`)
  assert.equal(fileMode, 0o600, `文件权限应为 600，实际 ${fileMode.toString(8)}`)
})
