// 工作台：DSH AppFrame（侧栏可收起 / 产物授权走 edge 面板 / 底部通栏）。
// 交互保持不变：发目标 → 工具卡 → 审批卡 → 产物；Esc 停止；刷新恢复历史。
const qs = new URLSearchParams(location.search)
const token = qs.get('token') || ''
const demo = qs.get('demo') === '1'
const sessionId = qs.get('sid') || 's_a1'

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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
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
  head.addEventListener('click', () => card.classList.toggle('open'))
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
  body.append(det)

  const actions = el('div', 'actions')
  const deny = el('button', 'btn danger', '拒绝')
  const sess = el('button', 'btn', '本会话允许')
  const once = el('button', 'btn primary', '允许一次')
  actions.append(deny, sess, once)

  const decide = async (decision) => {
    if (state.decided) return
    state.decided = true
    for (const b of [deny, once, sess]) b.disabled = true
    await api(`/api/approvals/${state.runId}`, { method: 'POST', body: JSON.stringify({ decision }) })
  }
  deny.addEventListener('click', () => decide('deny'))
  once.addEventListener('click', () => decide('allow_once'))
  sess.addEventListener('click', () => decide('allow_session'))

  card.append(head, body, actions)
  streamInner().append(card)
  return card
}

function autoNote(p) {
  const note = el('div', 'note')
  note.append(el('span', 'dot'), el('span', null, `已按会话授权放行 · ${label(p.tool)}`))
  streamInner().append(note)
}

function artifactNode(p) {
  const card = el('div', 'artifact')
  const ico = el('div', 'ico-box')
  ico.innerHTML = FILE_ICON
  const meta = el('div', 'meta-box')
  meta.append(el('div', 'nm', p.path), el('div', 'sz', `${p.mime || 'file'} · ${p.size || 0} B`))
  const href =
    `/api/artifacts/${encodeURIComponent(state.runId)}/` +
    p.path.split('/').map(encodeURIComponent).join('/') +
    `?token=${encodeURIComponent(token)}`
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
  if (type === 'text.delta') {
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
    if (p.decision === 'deny') setToolState(p.callId, 'muted', '已拒绝')
    else setToolState(p.callId, 'running', '执行中')
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
    setStatus('失败', 'done')
    state.es?.close()
  }
}

function subscribe(runId) {
  const es = new EventSource(`/api/runs/${runId}/events?token=${encodeURIComponent(token)}`)
  state.es = es
  for (const t of [
    'text.delta', 'tool.started', 'approval.requested', 'approval.auto_approved',
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
  if (status !== 202) { setStatus('提交失败', 'done'); return }
  state.runId = body.runId
  subscribe(body.runId)
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
  if (!token) {
    $('#who').textContent = 'no token'
    return
  }
  const me = await api('/api/me')
  $('#who').textContent = me.status === 200 ? `tenant ${me.body.tenantId}` : '未认证'
  $('#sbTenant').textContent = me.status === 200 ? `tenant ${me.body.tenantId}` : '-'

  const v = await fetch('/api/version').then((r) => r.json()).catch(() => ({ sha: '-' }))
  $('#sbBuild').textContent = `build ${v.sha}`
  $('#sbTime').textContent = new Date().toTimeString().slice(0, 8)
  $('#sbStatus').textContent = '空闲'

  const { body } = await api('/api/sessions')
  const ul = $('#sessions')
  ul.textContent = ''
  for (const s of body.sessions || []) {
    const li = el('li', s.id === state.sessionId ? 'active' : '', s.title)
    ul.append(li)
  }

  await loadHistory()
  if (demo) await send('把这三个 PDF 汇总成一份带目录的 docx')
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
  $('#grants').textContent = status === 200 ? `已撤销 ${body.revoked} 条授权` : `撤销失败（${status}）`
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && frame.dataset.panel === 'open' && e.target.id !== 'input') setPanel(false)
})

boot()
