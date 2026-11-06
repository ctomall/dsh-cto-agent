import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// model-doctor 是放行流程的第 4 步（node scripts/model-doctor.mjs [--probe]），
// 它必须能干净地区分三种情况：没配 / 配了且连通 / 配了但连不通。
const script = new URL('../../scripts/model-doctor.mjs', import.meta.url).pathname

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('没配 MODEL_* → exit 2 并给出所需变量', async () => {
  const r = await run([], {})
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /MODEL_BASE_URL/)
  assert.match(r.out, /未接通真实模型/)
})

test('配了且连通 → exit 0；--probe 会真发一次请求', async (t) => {
  const mock = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((r) => mock.listen(0, r))
  t.after(() => mock.close())

  const env = { MODEL_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, MODEL_NAME: 'm', MODEL_API_KEY: 'sk-t' }
  const plain = await run([], env)
  assert.equal(plain.code, 0, plain.out)
  assert.match(plain.out, /"real": true/)

  const probed = await run(['--probe'], env)
  assert.equal(probed.code, 0, probed.out)
  assert.match(probed.out, /probe ok: final/)
})

test('配了但连不通 → --probe exit 3 并打印失败原因', async () => {
  // 指向一个必然连不上的端口
  const r = await run(['--probe'], { MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'sk-t' })
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /probe FAILED/)
})
