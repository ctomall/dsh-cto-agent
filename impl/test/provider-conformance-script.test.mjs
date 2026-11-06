import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const script = new URL('../../scripts/provider-conformance.mjs', import.meta.url).pathname

// 一个"合格的" OpenAI 兼容端点：流式文本、tool_call、usage、未知模型 404
function compliantServer() {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = (() => { try { return JSON.parse(raw) } catch { return {} } })()
      if (String(body.model ?? '').includes('not-exist')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'model not found' } }))
      }
      const wantsTools = Array.isArray(body.tools) && body.tools.length > 0
      const stream = body.stream === true
      if (wantsTools) {
        const toolCall = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.write', arguments: '{"path":"a.md","content":"hello"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(toolCall))
      }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '一' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '二' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
        return res.end('data: [DONE]\n\n')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
    })
  })
}

test('一致性脚本：对合格端点给出全 pass 结论', async (t) => {
  const srv = compliantServer()
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  t.after(() => srv.close())

  // 必须异步 spawn：spawnSync 会阻塞事件循环，测试内起的服务端将无法响应 → 假死超时
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--base', `http://127.0.0.1:${port}/v1`, '--model', 'm', '--key', 'sk-test'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
  })
  const out = JSON.parse(r.stdout)
  const byName = Object.fromEntries(out.results.map((x) => [x.name, x.status]))
  assert.equal(byName['非流式回答'], 'pass')
  assert.equal(byName['流式增量'], 'pass')
  assert.equal(byName['tool_call'], 'pass')
  assert.equal(byName['usage'], 'pass')
  assert.equal(byName['错误映射'], 'pass')
  assert.equal(out.fails, 0)
  assert.equal(r.status, 0)
})
