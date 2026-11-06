import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('../../scripts/round-close.mjs', import.meta.url).pathname
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'round-close-'))
  const doc = join(dir, 'doc.md'), chunk = join(dir, 'chunk.md'), rec = join(dir, 'rec.json'), out = join(dir, 'out.jsonl')
  writeFileSync(doc, '# 文档\n\n锚点行\n\n尾行\n')
  writeFileSync(chunk, '**新小节**\n\n内容\n')
  writeFileSync(rec, JSON.stringify({ kind: 'delivery', note: 'x' }))
  return { dir, doc, chunk, rec, out }
}

test('文档补丁成功后才追加记录，并带上自检指纹', () => {
  const { doc, chunk, rec, out } = setup()
  const r = run(['--doc', doc, '--after', '锚点行', '--chunk', chunk, '--record', rec], { PUA_FEEDBACK_PATH: out })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(doc, 'utf8'), /\*\*新小节\*\*/)
  const lines = readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const json = JSON.parse(lines[0])
  assert.ok(json.doc_verified, '记录里必须有 doc_verified 指纹')
  assert.equal(json.doc_file, doc)
})

test('锚点不存在 → 拒绝写记录（这是这条约束的全部意义）', () => {
  const { doc, chunk, rec, out } = setup()
  const before = readFileSync(doc, 'utf8')
  const r = run(['--doc', doc, '--after', '不存在的锚点', '--chunk', chunk, '--record', rec], { PUA_FEEDBACK_PATH: out })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /拒绝写记录/)
  assert.equal(readFileSync(doc, 'utf8'), before, '失败时不得改文档')
  // 文件不存在 或 为空 都算"没写记录"
  let written = ''
  try { written = readFileSync(out, 'utf8') } catch { written = '' }
  assert.equal(written.trim(), '', '失败时不得写任何记录')
})
