import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// unblock.sh 的 apply 路径（写 key、写 env、重启、复验）平时不会跑——它只在接真 key 那天跑。
// 这里用「临时目录 + mock 端点 + 不重启」把这条路径整体跑一遍，确保它至少在结构上是通的。
test('unblock.sh apply：写入 key(0600) 与 env(MODEL_*)，并能读到 real 驱动', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keyFile = join(dir, 'model.key')
  const envFile = join(dir, 'env')

  // mock 端点：任何请求都回一个最终文本，足够让 model-doctor 的 status 判为 real
  const port = 8794
  const mock = spawn(process.execPath, ['scripts/mock-provider.mjs', String(port)], { stdio: 'ignore' })
  t.after(() => mock.kill('SIGKILL'))
  await new Promise((r) => setTimeout(r, 700))

  const r = await new Promise((resolve) => {
    const p = spawn('bash', ['scripts/unblock.sh', '--model-key', 'sk-test-123456', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--base', `http://127.0.0.1:${port}`], {
      env: {
        PATH: process.env.PATH,
        UNBLOCK_ENV_FILE: envFile,
        UNBLOCK_KEY_FILE: keyFile,
        UNBLOCK_SUDO: '',                 // 不调 sudo（临时目录）
        UNBLOCK_SYSTEMCTL: 'true',        // 不重启生产服务
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, // model-doctor 从 env 读
        MODEL_NAME: 'mock',
        MODEL_API_KEY_FILE: keyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let s = ''
    p.stdout.on('data', (c) => (s += c))
    p.stderr.on('data', (c) => (s += c))
    p.on('exit', (code) => resolve({ code, s }))
  })

  // key 文件：存在且 0600
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'model.key 必须是 0600')
  assert.match(readFileSync(keyFile, 'utf8'), /sk-test-123456/)
  // env 文件：含三行 MODEL_*
  const env = readFileSync(envFile, 'utf8')
  assert.match(env, /^MODEL_BASE_URL=/m)
  assert.match(env, /^MODEL_NAME=/m)
  assert.match(env, /^MODEL_API_KEY_FILE=/m)
  assert.ok(!env.includes('MODEL_API_KEY='), '不应把明文 key 写进 env（只写 _FILE）')
  // 输出里应报告真实驱动
  assert.match(r.s, /"real": true|real.*true/, r.s.slice(0, 400))
})
