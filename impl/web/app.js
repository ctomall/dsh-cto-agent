// 工作台：DSH AppFrame（侧栏可收起 / 产物授权走 edge 面板 / 底部通栏）。
// 交互保持不变：发目标 → 工具卡 → 审批卡 → 产物；Esc 停止；刷新恢复历史。
const qs = new URLSearchParams(location.search)
const token = qs.get('token') || ''
const demo = qs.get('demo') === '1'
// 不再用硬编码的 s_a1 兜底：它只存在于种子数据，生产上没有这个会话，
// 结果就是"没带 ?sid= 的首次访问，点发送什么也不会发生"（公网实测踩到）
const sessionId = qs.get('sid') || ''

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const TOOL_LABEL = {
  'fs.write': '写文件', 'fs.read': '读文件', 'shell.exec': '执行命令',
  'browser.open': '打开网页', 'kb.write': '写知识库', 'kb.search': '查知识库',
}
const label = (name) => TOOL_LABEL[name] || name
const pretty = (v) => { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }

const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M19 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h9l5 5v12a1 1 0 0 1-1 1Z"/></svg>'

const state = {
  runId: null, es: null, assistant: null, toolCards: new Map(), toolArgs: new Map(),
  decided: false, artifacts: 0, sessionId,
}

// 公网链路会丢包：没有超时的 fetch 会让页面"永远转圈、永不报错"（实测卡死一次）
const FETCH_TIMEOUT_MS = 15000
const fetchT = async (path, opts = {}) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(path, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function api(path, opts = {}) {
  const res = await fetchT(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'))
    body.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null
  }
  return { status: res.status, body }
}

// 429 的统一人话：告诉用户等多久，而不是「操作失败」
function rateLimitedText(body, fallback = '操作') {
  const wait = body?.retryAfter
  return `${fallback}过于频繁${wait ? `，请 ${wait} 秒后再试` : '，请稍后再试'}`
}

function streamInner() {
  let inner = $('.stream-inner')
  if (!inner) {
    inner = el('div', 'stream-inner')
    $('#stream').append(inner)
  }
  $('#empty')?.remove()
  return inner
}

function addUser(text) {
  const wrap = el('div', 'msg user')
  wrap.append(el('div', 'bubble', text))
  streamInner().append(wrap)
}

function ensureAssistant() {
  if (state.assistant) return state.assistant
  const wrap = el('div', 'msg assistant')
  const text = el('div', 'text')
  wrap.append(text)
  streamInner().append(wrap)
  state.assistant = text
  return text
}

function toolCard({ tool, callId }) {
  if (state.toolCards.has(callId)) return state.toolCards.get(callId).card
  const card = el('div', 'card tool')
  const head = el('div', 'card-head')
  const caret = el('span', 'caret', '▸')
  const dot = el('span', 'dot')
  const name = el('span', 'name', label(tool))
  const status = el('span', 'status status-running', '执行中')
  status.prepend(dot)
  head.append(caret, name, status)
  const body = el('div', 'card-body')
  body.append(el('p', 'label', '参数'))
  const pre = el('pre', null, '—')
  body.append(pre)
  card.append(head, body)
  const toggle = () => {
    const open = card.classList.toggle('open')
    head.setAttribute('aria-expanded', String(open))
  }
  head.tabIndex = 0
  head.setAttribute('role', 'button')
  head.setAttribute('aria-expanded', 'false')
  head.addEventListener('click', toggle)
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
  })
  state.toolCards.set(callId, { card, status })
  streamInner().append(card)
  return card
}

function setToolState(callId, kind, text) {
  const entry = state.toolCards.get(callId)
  if (!entry) return
  const { status } = entry
  status.className = `status status-${kind}`
  status.textContent = ''
  const dot = el('span', 'dot')
  if (kind === 'ok') dot.style.background = 'var(--green500)'
  if (kind === 'error') dot.style.background = 'var(--red600)'
  if (kind === 'muted') dot.style.background = 'var(--n400)'
  status.append(dot, el('span', null, text))
  const args = state.toolArgs.get(callId)
  const pre = entry.card.querySelector('pre')
  if (pre && args) pre.textContent = pretty(args)
}

function approvalCard(p) {
  const runId = p.runId || state.runId
  const key = `${runId}:${p.callId ?? ''}`
  state.approvalCards ??= new Map()
  if (state.approvalCards.has(key)) return state.approvalCards.get(key)
  const card = el('div', 'card approval')
  const head = el('div', 'card-head')
  head.append(el('span', 'title', `需要你确认 · ${label(p.action)}`))
  const body = el('div', 'body')

  const dl = el('dl')
  for (const [k, v] of [['目标', p.target], ['影响', p.impact]]) dl.append(el('dt', null, k), el('dd', null, v))
  body.append(dl)

  const det = document.createElement('details')
  det.append(el('summary', null, '参数'))
  det.append(el('pre', null, pretty(p.args)))
  // 参数过长时后端只发摘要：必须说清"这不是全文"，否则用户会以为模型只写了这么多
  if (p.argsTruncated) {
    det.append(el('p', 'muted', '参数较长，已截断显示；实际执行使用完整内容'))
  }
  body.append(det)

  const actions = el('div', 'actions')
  const deny = el('button', 'btn danger', '拒绝')
  const sess = el('button', 'btn', '本会话允许')
  const once = el('button', 'btn primary', '允许一次')
  actions.append(deny, sess, once)

  const DECISION_TEXT = { deny: '已拒绝', allow_once: '已允许一次', allow_session: '已允许本会话', session_grant: '已自动放行（会话授权）' }
  const markDecided = (decision) => {
    card.dataset.decision = decision
    // 结果显示在表头右侧：卡片可能很长，放底部会被折叠线挡住
    const tag = head.querySelector('.decided') ?? el('span', 'decided')
    tag.textContent = DECISION_TEXT[decision] ?? String(decision)
    if (!tag.parentElement) head.append(tag)
  }
  const decide = async (decision) => {
    if (state.decided) return
    state.decided = true
    for (const b of [deny, once, sess]) b.disabled = true
    const { status } = await api(`/api/approvals/${runId}`, { method: 'POST', body: JSON.stringify({ decision }) })
    if (status === 429) {
      state.decided = false
      for (const b of [deny, once, sess]) b.disabled = false
      setStatus(rateLimitedText({}, '审批'), 'error')
      return
    }
    if (status === 200) {
      markDecided(decision)
      // 同时更新上方工具卡的状态：刷新还原过的卡片不会走 SSE 的 callId 匹配
      setToolState(p.callId, decision === 'deny' ? 'muted' : 'running', decision === 'deny' ? '已拒绝' : '执行中')
      // POST 返回时授权已落库，这里刷新一次最稳妥（不依赖 SSE 时序）
      if (decision === 'allow_session') loadGrants()
    } else {
      // 失败要让用户能重试：恢复按钮并提示
      state.decided = false
      for (const b of [deny, once, sess]) b.disabled = false
      setStatus(`审批失败（${status}）`, 'error')
    }
  }
  card.__markDecided = markDecided
  deny.addEventListener('click', () => decide('deny'))
  once.addEventListener('click', () => decide('allow_once'))
  sess.addEventListener('click', () => decide('allow_session'))

  card.append(head, body, actions)
  streamInner().append(card)
  state.approvalCards.set(key, card)
  return card
}

function autoNote(p) {
  const note = el('div', 'note')
  note.append(el('span', 'dot'), el('span', null, `已按会话授权放行 · ${label(p.tool)}`))
  streamInner().append(note)
}

function artifactNode(p, runId = state.runId) {
  const card = el('div', 'artifact')
  const ico = el('div', 'ico-box')
  ico.innerHTML = FILE_ICON
  const meta = el('div', 'meta-box')
  meta.append(el('div', 'nm', p.path), el('div', 'sz', `${p.mime || 'file'} · ${p.size || 0} B`))
  const href =
    `/api/artifacts/${encodeURIComponent(runId)}/` +
    p.path.split('/').map(encodeURIComponent).join('/') +
    `?token=${encodeURIComponent(token)}&inline=1`
  const acts = el('div', 'acts')
  const preview = el('a', 'btn', '预览')
  preview.href = href
  preview.target = '_blank'
  preview.rel = 'noopener'
  const dl = el('a', 'btn', '下载')
  dl.href = href
  dl.setAttribute('download', '')
  acts.append(preview, dl)
  card.append(ico, meta, acts)
  return card
}

function artifactCard(p) {
  streamInner().append(artifactNode(p))
  const side = $('#artifacts')
  side.querySelector('.muted')?.remove()
  side.append(artifactNode(p))
  state.artifacts += 1
  $('#topBadge').textContent = String(state.artifacts)
  $('#railBadge').textContent = String(state.artifacts)
  $('#panelMeta').textContent = `${state.artifacts} 个产物`
}

function setStatus(text, kind) {
  const bar = $('#runbar')
  bar.hidden = false
  bar.dataset.state = kind
  $('#runlabel').textContent = text
  $('#stop').hidden = kind !== 'running' && kind !== 'waiting'
  $('#sbStatus').textContent = text
  if (kind === 'done') setTimeout(() => { if (bar.dataset.state === 'done') bar.hidden = true }, 1400)
}

function handleEvent(type, p) {
  if (type === 'run.started') {
    // 每轮一个助手块：否则第二轮文本会追加到第一轮的节点上（实测会粘成一段）
    state.assistant = null
  } else if (type === 'text.delta') {
    ensureAssistant().textContent += p.text
  } else if (type === 'tool.started') {
    if (p.args) state.toolArgs.set(p.callId, p.args)
    toolCard(p)
    setStatus(`${label(p.tool)} · 执行中`, 'running')
  } else if (type === 'approval.requested') {
    state.toolArgs.set(p.callId, p.args)
    setToolState(p.callId, 'muted', '等待确认')
    approvalCard(p)
    setStatus('等待你确认', 'waiting')
    if (window.innerWidth > 1023) setPanel(true)
  } else if (type === 'approval.auto_approved') {
    setToolState(p.callId, 'running', '自动放行')
    autoNote(p)
    setStatus('自动放行 · 执行中', 'running')
  } else if (type === 'approval.decided') {
    const key = `${runId}:${p.callId ?? ''}`
    const c = state.approvalCards?.get(key)
    if (c?.__markDecided) c.__markDecided(p.decision)
    if (p.decision === 'deny') setToolState(p.callId, 'muted', '已拒绝')
    else setToolState(p.callId, 'running', '执行中')
    if (p.decision === 'allow_session') loadGrants()
  } else if (type === 'tool.finished') {
    setToolState(p.callId, p.ok ? 'ok' : 'error', p.ok ? '完成' : p.error === 'denied_by_policy' ? '已拒绝' : '失败')
    setStatus(p.ok ? '执行完成' : '执行失败', 'running')
  } else if (type === 'artifact.created') {
    artifactCard(p)
  } else if (type === 'run.finished') {
    setStatus('完成', 'done')
    state.es?.close()
  } else if (type === 'run.canceled') {
    setStatus('已取消', 'done')
    state.es?.close()
  } else if (type === 'run.failed') {
    // 失败必须说清原因：真实模型的失败方式很多（超时/超步数/输出不合法/上下文超限），
    // 只显示一个"失败"等于把排查工作全丢给用户
    const reason = String(p?.error ?? '未知原因')
    setStatus(`失败：${reason.slice(0, 60)}`, 'done')
    // SSE 断线重连会重放事件：失败卡片必须按 runId 去重，否则重连一次就多一张
    state.failedRuns ??= new Set()
    const failKey = String(state.runId ?? '')
    if (state.failedRuns.has(failKey)) { state.es?.close(); return }
    state.failedRuns.add(failKey)
    const box = el('div', 'card error')
    const head = el('div', 'card-head')
    head.append(el('span', 'title', '运行失败'))
    const body = el('div', 'body')
    body.append(el('p', null, reason))
    box.append(head, body)
    streamInner().append(box)
    state.es?.close()
  }
}

function subscribe(runId, { lastEventId = 0 } = {}) {
  // 同一时刻只保留一条实时连接（避免连接泄漏与重复处理）。
  // 注：v176 实测证明"重复卡片"不是连接泄漏导致的（关掉旧连接后仍会处理两次），
  // 真正兜底的是 run.failed 的 runId 去重；这里的关闭仍保留，属于正确的资源纪律。
  try { state.es?.close() } catch {}
  const q = new URLSearchParams({ token })
  if (lastEventId) q.set('lastEventId', String(lastEventId))
  const es = new EventSource(`/api/runs/${runId}/events?${q.toString()}`)
  state.es = es
  for (const t of [
    'run.started', 'text.delta', 'tool.started', 'approval.requested', 'approval.auto_approved',
    'approval.decided', 'tool.finished', 'artifact.created', 'run.finished', 'run.canceled', 'run.failed',
  ]) {
    es.addEventListener(t, (e) => {
      try { handleEvent(t, JSON.parse(e.data)) } catch {}
    })
  }
}

async function send(text) {
  if (!text.trim()) return
  addUser(text)
  state.assistant = null
  state.decided = false
  $('#input').value = ''
  setStatus('已提交', 'running')
  const { status, body } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ input: text, sessionId: state.sessionId }) })
  if (status === 429) { setStatus(rateLimitedText(body, '发送'), 'error'); return }
  if (status !== 202) { setStatus('提交失败', 'done'); return }
  state.runId = body.runId
  subscribe(body.runId)
}

// 刷新/重开页面后，把仍在等待的审批卡还原出来（并重新订阅事件）
// 面板里的授权必须是真实数据（原来只在"撤销后"更新，永远显示"尚未授权"）
// 刷新后产物不能凭空消失：从会话级列表还原到面板
async function loadArtifacts() {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/artifacts`)
  const box = $('#artifacts')
  if (status !== 200) return
  const list = body.artifacts || []
  box.textContent = ''
  if (!list.length) {
    box.append(el('p', 'muted', '还没有产物'))
  } else {
    for (const a of list) box.append(artifactNode({ path: a.path, mime: a.mime, size: a.size }, a.runId))
  }
  state.artifacts = list.length
  $('#topBadge').textContent = String(state.artifacts)
  $('#railBadge').textContent = String(state.artifacts)
  $('#panelMeta').textContent = `${state.artifacts} 个产物`
}

async function loadGrants() {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/grants`)
  const box = $('#grants')
  if (status !== 200) { box.textContent = '读取失败'; return }
  const list = body.grants || []
  if (!list.length) { box.textContent = '尚未授权任何工具'; return }
  box.textContent = ''
  for (const g of list) box.append(el('div', 'grant-item', `${label(g.tool)} · 本会话`))
}

// 刷新/新开标签页时接上进行中的 run：从最后 seq 订阅，只收后续进展
async function loadActive() {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/active`)
  if (status !== 200 || !body.active?.length) return
  for (const a of body.active) {
    if (a.status === 'waiting_approval') continue // 交给 loadPending 渲染审批卡
    state.runId = a.runId
    setStatus('执行中（已续接）', 'running')
    subscribe(a.runId, { lastEventId: a.lastSeq })
  }
}

async function loadPending() {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/pending`)
  if (status !== 200 || !body.pending?.length) return
  for (const p of body.pending) {
    state.runId = p.runId
    state.decided = false
    toolCard({ tool: p.tool, callId: p.callId })
    setToolState(p.callId, 'muted', '等待确认')
    approvalCard({
      runId: p.runId, action: p.tool, target: p.target, impact: p.impact, args: p.args, callId: p.callId,
      ...(p.argsTruncated ? { argsTruncated: true } : {}),
    })
    // 从「当前最后一条事件」开始订阅：既拿到后续进展，又不把已渲染的旧事件再放一遍
    const seq = await lastSeq(p.runId)
    subscribe(p.runId, { lastEventId: seq })
  }
  setStatus('等待你确认', 'waiting')
}

async function lastSeq(runId) {
  try {
    const res = await fetchT(`/api/runs/${runId}/events?replay=1&token=${encodeURIComponent(token)}`)
    const text = await res.text()
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    return ids.length ? Math.max(...ids) : 0
  } catch {
    return 0
  }
}

// 驱动必须如实展示：模型没接上时，页面不能看起来像一个真在思考的 agent
async function loadDriver() {
  const { status, body } = await api('/api/model/status')
  const elx = $('#sbDriver')
  if (!elx) return
  if (status !== 200) { elx.textContent = '驱动 ?'; return }
  elx.textContent = body.real ? `驱动 ${body.driver}` : '演示驱动（未接模型）'
  elx.dataset.real = body.real ? '1' : '0'
  elx.title = body.real ? `模型：${body.driver}` : `未配置真实模型：${body.source ?? ''}（见 HANDOFF ①）`
}

// 会话重命名：双击（或聚焦后回车）就地编辑；Enter 保存，Esc 取消
async function startRename() {
  const h = $('#title')
  if (!h || h.dataset.editing === '1') return
  const original = h.textContent
  h.dataset.editing = '1'
  const input = document.createElement('input')
  input.className = 'title-input'
  input.value = original
  input.maxLength = 60
  h.textContent = ''
  h.append(input)
  input.focus()
  input.select()
  const finish = async (save) => {
    if (h.dataset.editing !== '1') return
    h.dataset.editing = '0'
    const next = input.value.trim()
    input.remove()
    if (!save || !next || next === original) { h.textContent = original; return }
    const { status } = await api(`/api/sessions/${state.sessionId}`, { method: 'PATCH', body: JSON.stringify({ title: next }) })
    h.textContent = status === 200 ? next : original
    if (status !== 200) setStatus('重命名失败', 'error')
    loadSessions().catch(() => {})
  }
  input.addEventListener('keydown', (e) => {
    // 阻止冒泡：title 上也有 keydown 监听，否则回车会重新进入编辑态
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
  return input
}

async function loadHistory() {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/messages`)
  if (status !== 200 || !body.messages?.length) return
  for (const m of body.messages) {
    if (m.role === 'user') addUser(m.content)
    else { state.assistant = null; ensureAssistant().textContent = m.content }
  }
}

async function cancelRun() {
  if (state.runId) await api(`/api/runs/${state.runId}/cancel`, { method: 'POST', body: '{}' })
  state.es?.close()
  setStatus('已停止', 'done')
}

// ——— AppFrame 交互 ———
const frame = $('#frame')
$('#toggleRail').addEventListener('click', () => {
  frame.dataset.rail = frame.dataset.rail === 'collapsed' ? 'expanded' : 'collapsed'
})
const panel = $('#panel')
function setPanel(open) {
  panel.hidden = !open
  frame.dataset.panel = open ? 'open' : 'closed'
}
$('#openArtifacts').addEventListener('click', () => setPanel(true))
$('#openArtifactsTop').addEventListener('click', () => setPanel(true))
$('#closePanel').addEventListener('click', () => setPanel(false))

async function boot() {
  // 身份有两种：URL 里的 ?token=（多租户），或口令门下发的 HttpOnly Cookie。
  // Cookie 读不到（HttpOnly），所以直接问服务端，别用 document.cookie 判断。
  const me = await api('/api/me')
  if (me.status !== 200) {
    $('#who').textContent = '未认证'
    return
  }
  $('#who').textContent = `tenant ${me.body.tenantId}`
  $('#sbTenant').textContent = me.status === 200 ? `tenant ${me.body.tenantId}` : '-'

  const v = await fetchT('/api/version').then((r) => r.json()).catch(() => ({ sha: '-' }))
  $('#sbBuild').textContent = `build ${v.sha}`
  $('#sbTime').textContent = new Date().toTimeString().slice(0, 8)
  $('#sbStatus').textContent = '空闲'

  const cur = await api(`/api/sessions/${state.sessionId}`)
  if (cur.status === 200 && cur.body.session?.title) $('#title').textContent = cur.body.session.title

  const { body } = await api('/api/sessions')
  // 没带 sid：落到最近的会话；一个都没有就新建一个，保证"进来就能用"
  if (!state.sessionId) {
    const first = body.sessions?.[0]
    if (first) {
      state.sessionId = first.id
      const u = new URL(location.href)
      u.searchParams.set('sid', state.sessionId)
      if (!token) u.searchParams.delete('token')
      history.replaceState(null, '', u.toString())
    } else {
      const made = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '新的会话' }) })
      if (made.status === 201 || made.status === 200) {
        state.sessionId = made.body.id
        const u = new URL(location.href)
        u.searchParams.set('sid', state.sessionId)
        history.replaceState(null, '', u.toString())
      }
    }
  }
  const ul = $('#sessions')
  ul.textContent = ''
  for (const s of body.sessions || []) {
    const li = el('li', s.id === state.sessionId ? 'active' : '')
    li.dataset.title = String(s.title ?? '')
    li.setAttribute('role', 'listitem')
    const openSession = () => {
      const u = new URL(location.href)
      u.searchParams.set('sid', s.id)
      if (!token) u.searchParams.delete('token')
      location.href = u.toString()
    }
    // 语义正确：列表项里放两个真正的按钮，而不是「div 冒充按钮里再嵌按钮」
    const open = el('button', 'row-title', s.title)
    open.title = s.title
    open.addEventListener('click', openSession)
    li.append(open)

    // 删除：两段确认（先点 ✕，再点「确认删除」），避免误触直接把会话删干净
    const del = el('button', 'row-del', '✕')
    del.setAttribute('aria-label', `删除会话「${s.title}」`)
    del.title = '删除会话'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1'
        del.textContent = '确认删除'
        del.classList.add('armed')
        setTimeout(() => {
          if (del.dataset.armed === '1') { del.dataset.armed = '0'; del.textContent = '✕'; del.classList.remove('armed') }
        }, 4000)
        return
      }
      del.disabled = true
      const { status, body } = await api(`/api/sessions/${s.id}`, { method: 'DELETE' })
      if (status === 200) {
        li.remove()
        if (s.id === state.sessionId) location.href = '/'
      } else {
        del.disabled = false
        del.textContent = '✕'
        del.dataset.armed = '0'
        setStatus(status === 409 ? '有进行中的 run，先停止再删' : `删除失败（${status}）`, 'error')
        if (status === 409) body && console.warn('active runs:', body.active)
      }
    })
    li.append(del)
    ul.append(li)
  }

  await loadDriver()
  await loadHistory()
  await loadPending()
  await loadActive()
  await loadGrants()
  await loadArtifacts()
  const titleEl = $('#title')
  if (titleEl) {
    titleEl.addEventListener('dblclick', startRename)
    titleEl.addEventListener('keydown', (e) => {
      if (e.target !== titleEl) return // 输入框内的按键交给输入框处理
      if (e.key === 'Enter') { e.preventDefault(); startRename() }
    })
  }
  bindSessionFilter()
  if (demo) await send('把这三个 PDF 汇总成一份带目录的 docx')
}

// 会话筛选：纯前端过滤（列表已在内存里），并用「/」快速聚焦
function bindSessionFilter() {
  const box = $('#session-filter')
  const ul = $('#sessions')
  if (!box || !ul) return
  const apply = () => {
    const q = box.value.trim().toLowerCase()
    let shown = 0
    for (const li of ul.children) {
      const hit = !q || String(li.dataset.title ?? li.textContent).toLowerCase().includes(q)
      li.hidden = !hit
      if (hit) shown += 1
    }
    const cnt = $('#session-count')
    if (cnt) cnt.textContent = q ? `${shown}/${ul.children.length}` : `${ul.children.length}`
  }
  box.addEventListener('input', apply)
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.value = ''; apply() } })
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase()
    const typing = tag === 'input' || tag === 'textarea'
    if (!typing && e.key === '/') { e.preventDefault(); box.focus(); box.select() }
  })
  apply()
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault()
  send($('#input').value)
})
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#input').value) }
  if (e.key === 'Escape') cancelRun()
})
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { $('#input').value = chip.dataset.fill })
}
$('#stop').addEventListener('click', cancelRun)
$('#revoke').addEventListener('click', async () => {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/grants/revoke`, { method: 'POST', body: '{}' })
  if (status === 200) {
    await loadGrants()
    if (!body.revoked) $('#grants').textContent = '没有可撤销的授权'
  } else {
    $('#grants').textContent = `撤销失败（${status}）`
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && frame.dataset.panel === 'open' && e.target.id !== 'input') setPanel(false)
})

boot()
