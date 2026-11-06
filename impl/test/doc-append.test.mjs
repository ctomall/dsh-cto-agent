import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('../../scripts/doc-append.mjs', import.meta.url).pathname
function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

test('锚点唯一时插入成功，并对新内容做指纹自检', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-append-'))
  const doc = join(dir, 'doc.md'), txt = join(dir, 'chunk.md')
  writeFileSync(doc, 'line1\nANCHOR\nline3\n')
  writeFileSync(txt, '**新小节**\n\n内容在这里\n')
  const r = run(['--file', doc, '--after', 'ANCHOR', '--text', txt])
  assert.equal(r.status, 0, r.stderr)
  const out = readFileSync(doc, 'utf8')
  assert.ok(out.indexOf('ANCHOR') < out.indexOf('**新小节**'), '应插在锚点之后')
  assert.match(r.stdout, /OK: 已插入/)
})

test('锚点不存在 → 退出码 3 且文件不被修改（防止记录先写、补丁没打）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-append-'))
  const doc = join(dir, 'doc.md'), txt = join(dir, 'chunk.md')
  const before = 'line1\nline2\n'
  writeFileSync(doc, before)
  writeFileSync(txt, '**新小节**\n')
  const r = run(['--file', doc, '--after', '不存在的锚点', '--text', txt])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /命中 0 处/)
  assert.equal(readFileSync(doc, 'utf8'), before, '失败时不得改动文件')
})

test('锚点重复命中 → 退出码 3（多义锚点同样拒绝）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-append-'))
  const doc = join(dir, 'doc.md'), txt = join(dir, 'chunk.md')
  writeFileSync(doc, 'DUP\nx\nDUP\n')
  writeFileSync(txt, '**新小节**\n')
  const r = run(['--file', doc, '--after', 'DUP', '--text', txt])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /命中 2 处/)
})
