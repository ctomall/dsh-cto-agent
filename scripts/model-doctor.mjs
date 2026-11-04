#!/usr/bin/env node
// 模型配置自检：一眼看出线上是真模型还是假模型；--probe 会真发一次请求。
import { createDriverFromEnv } from '../impl/src/model.mjs'

const probe = process.argv.includes('--probe')
const { driver, source } = createDriverFromEnv()
const real = !driver.name.startsWith('fake')

console.log(JSON.stringify({ driver: driver.name, source, real }, null, 2))
if (!real) {
  console.log('\n未接通真实模型。需要：MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY（或 MODEL_API_KEY_FILE）')
  process.exit(2)
}
if (probe) {
  const t0 = Date.now()
  try {
    const out = await driver.complete({ messages: [{ role: 'user', content: 'ping' }], tools: [] })
    console.log('probe ok:', out.type, `(${Date.now() - t0}ms)`, JSON.stringify(out).slice(0, 200))
  } catch (e) {
    console.log('probe FAILED:', e.message)
    process.exit(3)
  }
}
