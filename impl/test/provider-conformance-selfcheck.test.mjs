import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

// provider-conformance 是"接真 key 当天先跑它"的工具；它自己坏了就没人知道。
// 这里用本地 mock provider 验它：能跑通、给出结构化结果、fails=0、至少两项 pass。
test('provider-conformance 对本地 mock 端点能产出结构化结论', async (t) => {
  const port = 8796
  const mock = spawn(process.execPath, ['scripts/mock-provider.mjs', String(port)], { stdio: 'ignore' })
  t.after(() => mock.kill('SIGKILL'))
  await new Promise((r) => setTimeout(r, 800))

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/provider-conformance.mjs', '--base', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--key', 'sk-mock'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    p.stdout.on('data', (c) => (s += c))
    p.stderr.on('data', (c) => (s += c))
    p.on('exit', (code) => resolve({ code, s }))
  })
  assert.equal(out.code, 0, out.s.slice(0, 400))
  const d = JSON.parse(out.s.slice(out.s.indexOf('{')))
  assert.ok(Array.isArray(d.results) && d.results.length >= 4, `应至少 4 项检查，实际 ${d.results?.length}`)
  assert.equal(d.fails, 0, JSON.stringify(d.results))
  const passes = d.results.filter((r) => r.status === 'pass').length
  assert.ok(passes >= 2, `至少两项 pass（实际 ${passes}）：${JSON.stringify(d.results)}`)
  // 每项都必须有 name/status/detail，便于人工按项排查
  for (const r of d.results) assert.ok(r.name && r.status && 'detail' in r, JSON.stringify(r))
})
