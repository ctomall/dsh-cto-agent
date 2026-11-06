import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAiDriver } from '../src/model.mjs'

// 驱动层 fuzz：真实链路会断流、会脏数据。要求：**不悬挂、不崩**，
// 要么给出 decision，要么抛出可读错误。
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000 }
}

function chaosBody(rand) {
  const kind = Math.floor(rand() * 5)
  if (kind === 0) return 'data: {invalid json}\n\n'                       // 脏 JSON
  if (kind === 1) return 'data: {"choices":[{"delta":{"content":"ok"}}]}\n' // 缺结尾换行、断流
  if (kind === 2) return 'garbage-not-sse\n\n'                            // 完全不是 SSE
  if (kind === 3) return 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"fs.write","arguments":"{\\"path\\":"}}]}}]}\n\n' // 参数被截断
  return 'data: {"choices":[{"delta":{"content":"\\u4f60'               // 半个多字节字符
}

test('驱动层 fuzz（30 个种子）：脏流/断流不悬挂、不崩溃', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = rng(seed)
    const body = chaosBody(rand)
    const srv = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(body)
        res.end() // 直接断流，不发 [DONE]
      })
    })
    await new Promise((r) => srv.listen(0, r))
    const port = srv.address().port
    const driver = createOpenAiDriver({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', timeoutMs: 3000 })
    const label = `seed=${seed} kind=${JSON.stringify(body.slice(0, 20))}`
    const out = await Promise.race([
      driver.complete({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
        .then((d) => ({ kind: 'resolved', d }))
        .catch((e) => ({ kind: 'rejected', e })),
      new Promise((r) => setTimeout(() => r({ kind: 'hang' }), 5000)),
    ])
    srv.close()
    assert.notEqual(out.kind, 'hang', `${label} 悬挂了（>5s 未返回）`)
    if (out.kind === 'resolved') {
      assert.ok(['final', 'tool_call'].includes(out.d.type), `${label} 返回了未知类型 ${out.d.type}`)
      if (out.d.type === 'tool_call') assert.equal(typeof out.d.call.name, 'string')
    } else {
      assert.ok(out.e instanceof Error, `${label} 拒绝时必须是 Error`)
    }
  }
})
