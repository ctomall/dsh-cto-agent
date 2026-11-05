// 最小前端：会话流 + 工具卡 + 审批卡 + 产物卡。无构建步骤，直接 ES 模块。
const qs = new URLSearchParams(location.search)
const token = qs.get('token') || ''
const demo = qs.get('demo') === '1'

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const sessionId = qs.get('sid') || 's_a1'
const state = { runId: null, es: null, assistant: null, seq: 0, sessionId }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

function streamBox() {
  let inner = $('.stream-inner')
  if (!inner) {
    inner = el('div', 'stream-inner')
    $('#stream').append(inner)
    $('#empty')?.remove()
  }
  return inner
}

function appendUser(text) {
  const box = streamBox()
  const wrap = el('div', 'msg user')
  wrap.append(el('div', 'bubble', text))
  box.append(wrap)
}

function assistantBubble() {
  const box = streamBox()
  const wrap = el('div', 'msg assistant')
  const cap = el('div', 'caption', 'Agent')
  const b = el('div', 'bubble')
  wrap.append(cap, b)
  box.append(wrap)
  state.assistant = b
  return b
}

function toolCard({ tool, callId }) {
  const card = el('div', 'card tool')
  const head = el('div', 'card-head')
  head.append(el('span', 'name', tool), el('span', 'meta', callId), el('span', 'status running', '运行中'))
  const body = el('div', 'card-body')
  const l1 = el('p', 'label', '请求参数')
  const pre = el('pre', null, JSON.stringify({ cmd: 'ls -la', cwd: '.' }, null, 2))
  body.append(l1, pre)
  card.append(head, body)
  head.addEventListener('click', () => card.classList.toggle('open'))
  streamBox().append(card)
  return card
}

function approvalCard(p) {
  const card = el('div', 'card approval')
  const head = el('div', 'card-head')
  head.append(el('span', 'title', `需要你确认：${p.action}`))
  const body = el('div', 'body')
  const dl = el('dl')
  const rows = [['目标', p.target], ['影响', p.impact], ['参数', JSON.stringify(p.args)]]
  for (const [k, v] of rows) {
    dl.append(el('dt', null, k), el('dd', null, v))
  }
  body.append(dl)
  const actions = el('div', 'actions')
  const btnDeny = el('button', 'btn danger', '拒绝')
  const btnSession = el('button', 'btn', '本会话允许')
  const btnOnce = el('button', 'btn primary', '允许一次')
  actions.append(btnDeny, btnSession, btnOnce)
  card.append(head, body, actions)

  const decide = async (decision) => {
    if (state.decided) return
    state.decided = true
    for (const b of [btnDeny, btnSession, btnOnce]) b.disabled = true
    card.dataset.decision = decision
    await api(`/api/approvals/${state.runId}`, { method: 'POST', body: JSON.stringify({ decision }) })
  }
  btnDeny.addEventListener('click', () => decide('deny'))
  btnSession.addEventListener('click', () => decide('allow_session'))
  btnOnce.addEventListener('click', () => decide('allow_once'))

  streamBox().append(card)
  return card
}

function artifactCard(p) {
  const card = el('div', 'artifact')
  card.append(el('div', 'ico', '▤'))
  const meta = el('div')
  meta.append(el('div', 'nm', p.path), el('div', 'sz', `${p.mime || 'file'} · ${p.size || 0} B`))
  card.append(meta)
  const acts = el('div', 'acts')
  const href = `/api/artifacts/${encodeURIComponent(state.runId)}/${p.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?token=${encodeURIComponent(token)}`
  const preview = el('a', 'btn', '预览')
  preview.href = href
  preview.target = '_blank'
  preview.rel = 'noopener'
  const dl = el('a', 'btn primary', '下载')
  dl.href = href
  dl.setAttribute('download', '')
  acts.append(preview, dl)
  card.append(acts)
  streamBox().append(card)
  $('#artifacts').querySelector('.muted')?.remove()
  $('#artifacts').append(card.cloneNode(true))
}

function setStatus(text, done) {
  $('#runbar').hidden = false
  $('#runlabel').textContent = text
  if (done) $('#runbar').classList.add('done')
}

function handleEvent(type, p) {
  if (type === 'text.delta') {
    const b = state.assistant || assistantBubble()
    b.textContent += p.text
  } else if (type === 'tool.started') {
    toolCard(p)
    setStatus(`正在执行 ${p.tool} · 0s`, false)
  } else if (type === 'approval.requested') {
    approvalCard(p)
    setStatus('等待你确认', false)
    // 截图模式：拿到审批卡后断开长连接，让页面进入 network idle
    if (qs.get('shot') === '1') setTimeout(() => state.es?.close(), 300)
  } else if (type === 'approval.auto_approved') {
    const box = streamBox()
    const note = el('div', 'card auto')
    const head = el('div', 'card-head')
    head.append(el('span', 'name', `已按会话授权自动放行：${p.tool}`), el('span', 'status ok', 'auto'))
    note.append(head)
    box.append(note)
    setStatus('执行完成', false)
  } else if (type === 'approval.decided') {
    document.querySelectorAll('.approval').forEach((c) => {
      if (!c.dataset.decision) c.dataset.decision = p.decision
    })
  } else if (type === 'tool.finished') {
    const card = document.querySelector('.card.tool .status')
    if (card) { card.textContent = '完成'; card.className = 'status ok' }
    setStatus('执行完成', false)
  } else if (type === 'artifact.created') {
    artifactCard(p)
  } else if (type === 'run.finished') {
    setStatus('完成', true)
    setTimeout(() => { $('#runbar').hidden = true }, 800)
    state.es?.close()
  } else if (type === 'run.canceled') {
    setStatus('已取消', true)
    state.es?.close()
  }
}

function subscribe(runId) {
  const es = new EventSource(`/api/runs/${runId}/events?token=${encodeURIComponent(token)}`)
  state.es = es
  for (const t of ['text.delta', 'tool.started', 'approval.requested', 'approval.auto_approved', 'approval.decided', 'tool.finished', 'artifact.created', 'run.finished', 'run.canceled', 'run.failed']) {
    es.addEventListener(t, (e) => {
      try { handleEvent(t, JSON.parse(e.data)) } catch {}
    })
  }
}

async function send(text) {
  if (!text.trim()) return
  appendUser(text)
  assistantBubble()
  $('#input').value = ''
  setStatus('已提交，等待规划', false)
  const { status, body } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ input: text, sessionId: state.sessionId }) })
  if (status !== 202) { setStatus('提交失败', true); return }
  state.runId = body.runId
  state.decided = false
  subscribe(body.runId)
}

async function $('#revoke').addEventListener('click', async () => {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/grants/revoke`, { method: 'POST', body: '{}' })
  $('#grants').textContent = status === 200 ? `已撤销 ${body.revoked} 条本会话授权` : `撤销失败（${status}）`
})

boot() {
  if (!token) {
    $('#who').textContent = 'no token'
    return
  }
  const me = await api('/api/me')
  $('#who').textContent = me.status === 200 ? me.body.tenantId : 'unauth'
  const v = await fetch('/api/version').then((r) => r.json()).catch(() => ({ sha: '-' }))
  $('#ver').textContent = v.sha

  const { body } = await api('/api/sessions')
  const ul = $('#sessions')
  ul.innerHTML = ''
  for (const s of body.sessions || []) {
    const li = el('li', s.id === 's_a1' ? 'active' : '', s.title)
    ul.append(li)
  }

  await loadHistory()

  if (demo) {
    await send('把这三个 PDF 汇总成一份带目录的 docx')
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault()
  send($('#input').value)
})
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#input').value) }
  if (e.key === 'Escape') { state.es?.close(); setStatus('已停止', true) }
})
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { $('#input').value = chip.dataset.fill })
}
$('#stop').addEventListener('click', () => { state.es?.close(); setStatus('已停止', true) })

$('#revoke').addEventListener('click', async () => {
  const { status, body } = await api(`/api/sessions/${state.sessionId}/grants/revoke`, { method: 'POST', body: '{}' })
  $('#grants').textContent = status === 200 ? `已撤销 ${body.revoked} 条本会话授权` : `撤销失败（${status}）`
})

boot()
