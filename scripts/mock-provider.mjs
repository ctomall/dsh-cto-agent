#!/usr/bin/env node
// OpenAI 兼容的本地 mock（流式），只为验证"接线"：先给 tool_call（需审批），再给最终文本。
// 它不是模型，产出内容固定；用于 scripts/first-real-run.sh 的自测。
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8796)
let call = 0

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    call += 1
    const streaming = (() => { try { return JSON.parse(body).stream === true } catch { return false } })()
    if (!streaming) { res.writeHead(400); return res.end('expected stream') }
    if (call % 2 === 1) {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${call}`, function: { name: 'fs.write', arguments: '{"path":"mock-report.md",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"# mock 产物"}' } }] } }] },
      ])
    } else {
      sse(res, [
        { choices: [{ delta: { content: '已写入 ' } }] },
        { choices: [{ delta: { content: 'mock-report.md' } }] },
      ])
    }
  })
}).listen(port, () => console.log(`mock provider on http://127.0.0.1:${port}/v1`))
