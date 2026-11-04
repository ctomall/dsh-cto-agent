import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpgrade, createUpgradeRoute, UpgradeError } from '../src/upgrade.mjs'

// 用可注入的假 git，断言"发的是哪条命令、错了怎么返回"，避免测试依赖真实远程
function fakeExec(handlers) {
  const calls = []
  const fn = async (args) => {
    calls.push(args.join(' '))
    const h = handlers[args[0]]
    if (!h) return ''
    return typeof h === 'function' ? h(args) : h
  }
  fn.calls = calls
  return fn
}

test('未配置 token → 503 关闭（fail-closed）', async () => {
  const route = createUpgradeRoute({ token: undefined, upgradeOnce: async () => ({}) })
  const r = await route({ headers: {} })
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'upgrade_disabled')
})

test('token 错误 / 缺失 → 401', async () => {
  const route = createUpgradeRoute({ token: 'secret', upgradeOnce: async () => ({}) })
  assert.equal((await route({ headers: {} })).status, 401)
  assert.equal((await route({ headers: { 'x-upgrade-token': 'wrong' } })).status, 401)
})

test('正常升级：返回 before/after/behind', async () => {
  const route = createUpgradeRoute({ token: 'secret', upgradeOnce: async () => ({ ok: true, before: 'aaa', after: 'bbb', behind: 2 }) })
  const r = await route({ headers: { 'x-upgrade-token': 'secret' } })
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.before, r.body.after, r.body.behind], ['aaa', 'bbb', 2])
})

test('脏工作区 → 409，且不执行 fetch/pull', async () => {
  const exec = fakeExec({ 'rev-parse': 'true', status: ' M README.md\n' })
  const up = createUpgrade({ repoDir: '/repo', exec })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'dirty_worktree')
  assert.equal(exec.calls.some((c) => c.startsWith('fetch')), false)
  assert.equal(exec.calls.some((c) => c.startsWith('pull')), false)
})

test('已是最新：不执行 pull', async () => {
  const exec = fakeExec({
    'rev-parse': (args) => (args.includes('--short') ? 'aaa' : 'true'),
    status: '',
    fetch: '',
    'rev-list': '0',
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  const r = await up()
  assert.equal(r.upToDate, true)
  assert.equal(r.before, 'aaa')
  assert.equal(exec.calls.some((c) => c.startsWith('pull')), false)
})

test('落后 N 个提交：ff-only 拉取并返回新 SHA', async () => {
  let shortCalls = 0
  const exec = fakeExec({
    'rev-parse': (args) => {
      if (args.includes('--short')) return ['aaa', 'bbb'][Math.min(shortCalls++, 1)]
      return 'true'
    },
    status: '',
    fetch: '',
    'rev-list': '3',
    pull: '',
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  const r = await up()
  assert.equal(r.upToDate, false)
  assert.equal(r.behind, 3)
  assert.deepEqual([r.before, r.after], ['aaa', 'bbb'])
  assert.ok(exec.calls.includes('pull --ff-only origin main'))
})

test('并发调用 → 第二次 409（单飞锁）', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const exec = async (args) => {
    if (args[0] === 'rev-parse' && !args.includes('--short')) return 'true'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return 'aaa'
    if (args[0] === 'fetch') { await gate; return '' }
    return ''
  }
  const up = createUpgrade({ repoDir: '/repo', exec })
  const first = up()
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'upgrade_in_progress')
  release()
  await first
})

test('fetch 失败 → 502，不冒成 500', async () => {
  const exec = fakeExec({
    'rev-parse': (args) => (args.includes('--short') ? 'aaa' : 'true'),
    status: '',
    fetch: () => { throw new Error('remote unreachable') },
  })
  const up = createUpgrade({ repoDir: '/repo', exec })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.status === 502)
})

test('CUBE_TOKENS 注入时以 env 为准，且拒绝空集合', async () => {
  const { loadTokens } = await import('../src/context.mjs')
  const r = loadTokens({ CUBE_TOKENS: JSON.stringify({ 'real-token': { tenantId: 't_a', userId: 'u_a' } }) })
  assert.equal(r.source, 'env')
  assert.equal(r.tokens.has('real-token'), true)
  assert.equal(r.tokens.has('tok_a'), false)
  assert.throws(() => loadTokens({ CUBE_TOKENS: '{}' }), /拒绝启动/)
})

test('/api/version 返回启动快照 SHA', async () => {
  const { handleRequest } = await import('../src/server.mjs')
  const { openDb } = await import('../src/db.mjs')
  const r = handleRequest(openDb(), { method: 'GET', url: '/api/version', headers: {} })
  assert.equal(r.status, 200)
  assert.match(r.body.sha, /^[0-9a-f]{7,}$|^unknown$/)
})

test('前端链路：创建 run → 停在审批 → 允许一次 → 产生产物', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { EventLog } = await import('../src/events.mjs')
  const { RunController } = await import('../src/runs.mjs')
  const db = openDb(); seedTwoTenants(db)
  const log = new EventLog(db)
  const app = createApp(db, { log, rc: new RunController(db, log) })
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const created = await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写个文件' }) })
  assert.equal(created.status, 202)
  const { runId } = await created.json()

  const page = await fetch(`${base}/`).then((r) => r.text())
  assert.match(page, /cube<span>·agent<\/span>/)

  const decided = await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_once' }) })
  const body = await decided.json()
  assert.equal(body.status, 'done')
  const types = log.after(runId, 0).map((e) => e.type)
  assert.deepEqual(types, [
    'run.started', 'text.delta', 'tool.started', 'approval.requested',
    'approval.decided', 'tool.finished', 'artifact.created', 'text.delta', 'run.finished',
  ])
})

test('拒绝审批 → run.canceled，不产生产物', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { EventLog } = await import('../src/events.mjs')
  const { RunController } = await import('../src/runs.mjs')
  const db = openDb(); seedTwoTenants(db)
  const log = new EventLog(db)
  const app = createApp(db, { log, rc: new RunController(db, log) })
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }
  const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写个文件' }) })).json()
  const r = await fetch(`${base}/api/approvals/${runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'deny' }) })
  assert.equal((await r.json()).status, 'canceled')
  const types = log.after(runId, 0).map((e) => e.type)
  assert.equal(types.includes('artifact.created'), false)
  assert.equal(types.at(-1), 'run.canceled')
})

test('模型决策驱动：不同输入触发不同工具（不是硬编码序列）', async (t) => {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { EventLog } = await import('../src/events.mjs')
  const { RunController } = await import('../src/runs.mjs')
  const db = openDb(); seedTwoTenants(db)
  const log = new EventLog(db)
  const app = createApp(db, { log, rc: new RunController(db, log) })
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  const base = `http://127.0.0.1:${app.address().port}`
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  const write = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告' }) })).json()
  const read = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '读一下 report.md' }) })).json()

  const wTools = log.after(write.runId, 0).filter((e) => e.type === 'tool.started').map((e) => e.payload.tool)
  const rTools = log.after(read.runId, 0).filter((e) => e.type === 'tool.started').map((e) => e.payload.tool)
  assert.deepEqual(wTools, ['fs.write'])
  assert.deepEqual(rTools, ['fs.read'])
  // 只读工具策略是 auto：不应出现审批请求
  const rTypes = log.after(read.runId, 0).map((e) => e.type)
  assert.equal(rTypes.includes('approval.requested'), false)
})

test('真实 provider 代码路径：本地 mock /chat/completions 驱动 loop', async (t) => {
  const { createServer } = await import('node:http')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { EventLog } = await import('../src/events.mjs')
  const { RunController } = await import('../src/runs.mjs')
  const { AgentLoop } = await import('../src/loop.mjs')
  const { createTools } = await import('../src/tools.mjs')
  const { createOpenAiDriver } = await import('../src/model.mjs')

  let calls = 0
  const provider = createServer((req, res) => {
    calls++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (calls === 1) {
        res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'tc1', function: { name: 'fs.write', arguments: JSON.stringify({ path: 'p.md', content: '# from provider' }) } }] } }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: `模型收尾（第 ${calls} 次调用）` } }] }))
      }
    })
  })
  await new Promise((r) => provider.listen(0, r))
  t.after(() => provider.close())
  const baseUrl = `http://127.0.0.1:${provider.address().port}`

  const db = openDb(); seedTwoTenants(db)
  const log = new EventLog(db)
  const rc = new RunController(db, log)
  const loop = new AgentLoop({
    rc,
    tools: createTools({ workspaceRoot: '/tmp/cw-provider' }),
    driver: createOpenAiDriver({ baseUrl, apiKey: 'test-key', model: 'mock-1' }),
    workspaceRoot: '/tmp/cw-provider',
  })

  const r1 = await loop.start({ runId: 'rp1', input: '生成文件' })
  assert.equal(r1.status, 'waiting_approval')
  const r2 = await loop.resume({ runId: 'rp1', decision: 'allow_once' })
  assert.equal(r2.status, 'done')
  assert.equal(calls, 2)

  const types = log.after('rp1', 0).map((e) => e.type)
  assert.ok(types.includes('tool.started') && types.includes('artifact.created') && types.includes('run.finished'))
  assert.equal(rc.status('rp1'), 'done')
})

async function bootServer(t) {
  const { createApp } = await import('../src/server.mjs')
  const { openDb, seedTwoTenants } = await import('../src/db.mjs')
  const { EventLog } = await import('../src/events.mjs')
  const { RunController } = await import('../src/runs.mjs')
  const db = openDb(); seedTwoTenants(db)
  const log = new EventLog(db)
  const app = createApp(db, { log, rc: new RunController(db, log) })
  t.after(() => app.close())
  await new Promise((r) => app.listen(0, r))
  return { base: `http://127.0.0.1:${app.address().port}`, db, log }
}

const post = (base, path, body, token = 'tok_a') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

test('会话级授权：同一会话第二次同工具不再弹审批卡', async (t) => {
  const { base, log } = await bootServer(t)

  const first = await (await post(base, '/api/runs', { input: '写一份报告', sessionId: 's_a1' })).json()
  const d1 = await (await post(base, `/api/approvals/${first.runId}`, { decision: 'allow_session' })).json()
  assert.equal(d1.status, 'done')

  const second = await (await post(base, '/api/runs', { input: '再写一份报告', sessionId: 's_a1' })).json()
  const types2 = log.after(second.runId, 0).map((e) => e.type)
  assert.equal(types2.includes('approval.requested'), false, '第二次不应再弹审批')
  assert.equal(types2.includes('approval.auto_approved'), true, '应留下自动放行事件')
  assert.equal(log.after(second.runId, 0).at(-1).type, 'run.finished')
})

test('会话级授权不跨会话继承', async (t) => {
  const { base, log, db } = await bootServer(t)
  db.prepare("insert into sessions (id, tenant_id, user_id, title) values ('s_a2','t_a','u_a','A 的第二个会话')").run()

  const first = await (await post(base, '/api/runs', { input: '写一份报告', sessionId: 's_a1' })).json()
  await post(base, `/api/approvals/${first.runId}`, { decision: 'allow_session' })

  // 同会话第二次：不弹卡
  const again = await (await post(base, '/api/runs', { input: '再写一份报告', sessionId: 's_a1' })).json()
  assert.equal(log.after(again.runId, 0).some((e) => e.type === 'approval.requested'), false)

  // 换一个同租户但不同的会话：必须重新弹卡
  const other = await (await post(base, '/api/runs', { input: '写一份报告', sessionId: 's_a2' })).json()
  assert.equal(other.sessionId, 's_a2')
  const types = log.after(other.runId, 0).map((e) => e.type)
  assert.equal(types.includes('approval.requested'), true, '不同会话必须重新审批')
  assert.equal(types.includes('approval.auto_approved'), false)
})

test('跨租户会话 id → 404，不泄露存在性', async (t) => {
  const { base } = await bootServer(t)
  const r = await post(base, '/api/runs', { input: '写文件', sessionId: 's_b1' })
  assert.equal(r.status, 404)
  const j = await r.json()
  assert.equal(j.error, 'not_found')
})

test('撤销会话授权后必须重新审批，并留下审计', async (t) => {
  const { base, log, db } = await bootServer(t)
  const H = { 'content-type': 'application/json', authorization: 'Bearer tok_a' }

  // 建会话 → 首次审批允许本会话
  const { id: sid } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '撤销测试' }) })).json()
  const r1 = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '写一份报告', sessionId: sid }) })).json()
  await fetch(`${base}/api/approvals/${r1.runId}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow_session' }) })

  // 复用生效
  const r2 = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '再写', sessionId: sid }) })).json()
  assert.equal(log.after(r2.runId, 0).some((e) => e.type === 'approval.auto_approved'), true)

  // 自动放行必须落审计
  const auditAuto = db.prepare("select count(*) c from audit_log where action = 'approval_auto_approved'").get()
  assert.ok(Number(auditAuto.c) >= 1)

  // 撤销
  const rv = await fetch(`${base}/api/sessions/${sid}/grants/revoke`, { method: 'POST', headers: H, body: '{}' })
  const rvBody = await rv.json()
  assert.equal(rv.status, 200)
  assert.equal(rvBody.revoked, 1)

  // 撤销后必须重新审批
  const r3 = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input: '再写', sessionId: sid }) })).json()
  assert.equal(log.after(r3.runId, 0).some((e) => e.type === 'approval.requested'), true)
})

test('跨租户撤销授权 → 404', async (t) => {
  const { base } = await bootServer(t)
  const r = await fetch(`${base}/api/sessions/s_a1/grants/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok_b' },
    body: '{}',
  })
  assert.equal(r.status, 404)
})

test('拉取后测试失败 → 自动回滚到 before', async () => {
  const { createUpgrade, UpgradeError } = await import('../src/upgrade.mjs')
  const calls = []
  const exec = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && !args.includes('--short')) return 'true'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return calls.filter((c) => c.startsWith('rev-parse --short')).length === 1 ? 'aaa' : 'bbb'
    if (args[0] === 'rev-list') return '1'
    return ''
  }
  const runCommand = async () => { throw new Error('1 test failed') }
  const up = createUpgrade({ repoDir: '/repo', exec, runCommand, runTests: true })
  await assert.rejects(() => up(), (e) => e instanceof UpgradeError && e.code === 'tests_failed_rolled_back')
  assert.ok(calls.includes('reset --hard aaa'), '必须回滚到 before')
})

test('测试通过则不回滚', async () => {
  const { createUpgrade } = await import('../src/upgrade.mjs')
  const calls = []
  const exec = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && !args.includes('--short')) return 'true'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return calls.filter((c) => c.startsWith('rev-parse --short')).length === 1 ? 'aaa' : 'bbb'
    if (args[0] === 'rev-list') return '1'
    return ''
  }
  const up = createUpgrade({ repoDir: '/repo', exec, runCommand: async () => 'ok', runTests: true })
  const r = await up()
  assert.equal(r.tests, 'passed')
  assert.equal(calls.some((c) => c.startsWith('reset')), false)
})
