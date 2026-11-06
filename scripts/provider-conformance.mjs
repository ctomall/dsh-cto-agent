#!/usr/bin/env node
// 给定任意 OpenAI 兼容端点，逐项验证"我们的驱动是否与它兼容"。
// 用法：node scripts/provider-conformance.mjs --base https://api.example.com/v1 --model m --key sk-xxx
//       （或用环境变量 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY）
// 输出：每项 pass/fail/skip + 结论，失败时给出原始错误片段。
import { createOpenAiDriver } from '../impl/src/model.mjs'

const args = process.argv.slice(2)
const get = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const baseUrl = get('base') ?? process.env.MODEL_BASE_URL
const model = get('model') ?? process.env.MODEL_NAME
const apiKey = get('key') ?? process.env.MODEL_API_KEY
if (!baseUrl || !model || !apiKey) {
  console.error('缺少参数：--base / --model / --key（或对应 MODEL_* 环境变量）')
  process.exit(2)
}

const driver = createOpenAiDriver({ baseUrl, apiKey, model, timeoutMs: 30_000 })
const results = []
const ok = (name, detail) => results.push({ name, status: 'pass', detail })
const bad = (name, detail) => results.push({ name, status: 'fail', detail: String(detail).slice(0, 200) })
const skip = (name, detail) => results.push({ name, status: 'skip', detail })

// 1) 基本连通 + 非流式回答
let out
try {
  out = await driver.complete({ messages: [{ role: 'user', content: '只回两个字：收到' }], tools: [] })
  if (out?.type === 'final' && typeof out.text === 'string') ok('非流式回答', `text=${JSON.stringify(out.text.slice(0, 30))}`)
  else bad('非流式回答', JSON.stringify(out)?.slice(0, 160))
} catch (e) {
  bad('非流式回答', e.message)
}

// 2) 流式（onDelta 是否真的被调用）
let deltas = 0
try {
  const out2 = await driver.complete({ messages: [{ role: 'user', content: '数到三' }], tools: [], onDelta: () => { deltas += 1 } })
  if (deltas > 0) ok('流式增量', `${deltas} 个 delta`)
  else skip('流式增量', `未收到 delta（可能是非流式端点）；type=${out2?.type}`)
} catch (e) {
  bad('流式增量', e.message)
}

// 3) 工具调用
try {
  const out3 = await driver.complete({
    messages: [{ role: 'user', content: '把 "hello" 写入文件 a.md，使用 fs.write 工具' }],
    tools: [{ name: 'fs.write', description: '写文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
  })
  if (out3?.type === 'tool_call') ok('tool_call', `${out3.call.name} args=${JSON.stringify(out3.call.args).slice(0, 80)}`)
  else skip('tool_call', `模型没有调用工具（type=${out3?.type}）—— 该端点可能不支持函数调用，这是信息不是错误`)
} catch (e) {
  bad('tool_call', e.message)
}

// 4) usage（计费口径）
try {
  const out4 = await driver.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
  if (out4?.usage && Number(out4.usage.total_tokens) > 0) ok('usage', JSON.stringify(out4.usage))
  else skip('usage', '响应未带 usage（成本统计会为空）')
} catch (e) {
  bad('usage', e.message)
}

// 5) 错误映射（故意用不存在的模型名）
try {
  const badDriver = createOpenAiDriver({ baseUrl, apiKey, model: `${model}-definitely-not-exist`, timeoutMs: 20_000 })
  await badDriver.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
  skip('错误映射', '不存在的模型也没有报错（端点可能过于宽松）')
} catch (e) {
  ok('错误映射', String(e.message).slice(0, 120))
}

const strict = args.includes('--strict')
const fails = results.filter((r) => r.status === 'fail' || (strict && r.status === 'skip')).length
console.log(JSON.stringify({ base: baseUrl.replace(/\/\/.*@/, '//***@'), model, results, fails }, null, 1))
process.exit(fails === 0 ? 0 : 1)
