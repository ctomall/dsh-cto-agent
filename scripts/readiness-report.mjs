#!/usr/bin/env node
// 生成"当前就绪状态"快照：所有数字都来自现场执行，不手写。
// 用法：node scripts/readiness-report.mjs [--base http://127.0.0.1:8787]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const base = baseIdx >= 0 ? args[baseIdx + 1] : 'http://127.0.0.1:8787'

const run = (cmd, argv, opts = {}) => {
  try { return { ok: true, out: execFileSync(cmd, argv, { encoding: 'utf8', timeout: opts.timeout ?? 300000, env: process.env, ...opts }).trim() } }
  catch (e) { return { ok: false, out: String(e.stdout ?? e.message).trim() } }
}

const rows = []
const add = (k, v, note = '') => rows.push({ k, v, note })

// 1) 测试
const testFiles = readdirSync('impl/test').filter((f) => f.endsWith('.test.mjs')).length
const t = run('node', ['--test', '--test-timeout=30000', ...readdirSync('impl/test').filter((f) => f.endsWith('.test.mjs')).map((f) => `impl/test/${f}`)])
const tm = t.out.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/)
add('全量测试', tm ? `pass=${tm[1]} fail=${tm[2]}（${testFiles} 文件）` : '未能解析', t.ok ? '' : '测试未全绿')

// 2) 验收
const a = run('bash', ['scripts/acceptance.sh', base], { timeout: 300000 })
const am = a.out.match(/== 汇总：pass=(\d+) fail=(\d+) skip=(\d+)/)
add('目标验收', am ? `pass=${am[1]} fail=${am[2]} skip=${am[3]}` : '未能解析', am && am[3] !== '0' ? 'SKIP 即 ①③ 未完成' : '')

// 3) 凭据（阻塞项）
const envHasModel = Object.keys(process.env).some((k) => k.startsWith('MODEL_'))
const modelKeyFile = existsSync('/etc/cube-agent/model.key')
const cfEnv = existsSync('/etc/cube-agent/cf.env')
add('① 模型凭据', envHasModel || modelKeyFile ? '已配置' : '**缺失**（MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY(_FILE)）', '')
add('③ Cloudflare 凭据', cfEnv || process.env.CLOUDFLARE_API_TOKEN ? '已配置' : '**缺失**（CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID）', '')

// 4) 运行态
const ver = run('curl', ['-s', '-m', '5', `${base}/api/version`])
add('线上版本', ver.out || '不可达', '')

// 5) 关键能力（有则为"已验证"，无则如实标"未验证"）
const drills = ['check-approval-truncation.mjs', 'check-no-dup-stream.mjs', 'check-failure-reason.mjs']
add('浏览器级演练脚本', drills.every((d) => existsSync(`scripts/${d}`)) ? `已就绪（${drills.length} 个）` : '缺失', '需 CDP :9222')
add('provider 一致性脚本', existsSync('scripts/provider-conformance.mjs') ? '已就绪' : '缺失', '接真 key 当天先跑它')

const width = Math.max(...rows.map((r) => r.k.length))
console.log('cube-agent 就绪快照（现场执行，非手写）')
console.log('='.repeat(46))
for (const r of rows) console.log(`${r.k.padEnd(width)} | ${r.v}${r.note ? '  · ' + r.note : ''}`)
console.log('='.repeat(46))
const blocked = rows.filter((r) => String(r.v).includes('缺失')).map((r) => r.k)
if (blocked.length) {
  console.log(`阻塞：${blocked.join(' / ')}`)
  console.log('放行：scripts/unblock.sh --model-key <KEY> --verify    |    scripts/unblock.sh --cf-token <T> --cf-account <A> --cf-zone <Z> --allow-emails <E>')
}
process.exit(0)
