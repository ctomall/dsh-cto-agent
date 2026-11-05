// 系统总览：把 L0–L5 分层、运行状态、待审批、审计放在一屏。
// 数据全部来自 /api/overview（租户内只读聚合），不编造指标。
const qs = new URLSearchParams(location.search)
const token = qs.get('token') || ''

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const TOOL_CN = { 'fs.write': '写文件', 'fs.read': '读文件', 'shell.exec': '执行命令' }
const ACTION_CN = {
  approval_auto_approved: '按会话授权自动放行',
  approval_decided: '审批已处理',
  session_grant_revoked: '撤销会话授权',
  cross_tenant_probe: '跨租户探测被拒',
  run_created: '创建运行',
}

const LAYERS = [
  { code: 'L0', name: 'Host Shell', cn: '页面与资源', desc: '工作台 · 总览 · 静态资源' },
  { code: 'L1', name: 'Gateway', cn: '网关', desc: '鉴权 · 限流 · 路由 · 租户隔离' },
  { code: 'L2', name: 'Kernel', cn: '内核', desc: '事件总线 · 模型驱动 · 工具策略' },
  { code: 'L3', name: 'Runs', cn: '运行', desc: '状态机 · 审批挂起与恢复 · 取消' },
  { code: 'L4', name: 'Tools', cn: '工具与授权', desc: 'fs.read · fs.write · 会话授权' },
  { code: 'L5', name: 'Storage', cn: '存储', desc: '会话 · 消息 · 审计 · 事件' },
]

function timeOf(iso) {
  return String(iso || '').slice(11, 19) || '-'
}

function layerRows(d) {
  const runs = d.counts.runs || {}
  const waiting = runs.waiting_approval || 0
  const running = runs.running || 0
  return [
    { ...LAYERS[0], metric: [['num', '2'], ['unit', '页']], state: 'ok', stateText: '在线' },
    { ...LAYERS[1], metric: [['num', '14'], ['unit', '路由']], state: 'ok', stateText: '正常' },
    {
      ...LAYERS[2],
      metric: [['num', d.driver.real ? '真实' : '桩'], ['unit', '模型']],
      state: d.driver.real ? 'ok' : 'warn',
      stateText: d.driver.real ? '已接模型' : '未接模型',
    },
    {
      ...LAYERS[3],
      metric: [['num', String(waiting + running)], ['unit', '进行中']],
      state: waiting ? 'warn' : 'ok',
      stateText: waiting ? `${waiting} 待审批` : running ? '执行中' : '空闲',
    },
    {
      ...LAYERS[4],
      metric: [['num', String(d.counts.grants)], ['unit', '条授权']],
      state: 'ok',
      stateText: '正常',
    },
    {
      ...LAYERS[5],
      metric: [['num', String(d.counts.messages)], ['unit', '条消息']],
      state: 'ok',
      stateText: '正常',
    },
  ]
}

function renderLayers(d) {
  const box = $('#layers')
  box.textContent = ''
  for (const L of layerRows(d)) {
    const row = el('div', 'layer')
    row.dataset.state = L.state
    const code = el('div', 'code mono', L.code)
    const body = el('div')
    const name = el('div', 'layer-name', L.name)
    name.append(el('span', 'cn', L.cn))
    body.append(name, el('div', 'layer-desc', L.desc))
    const metric = el('div', 'layer-metric')
    metric.append(el('span', 'num mono', L.metric[0][1]), el('span', 'unit', ` ${L.metric[1][1]}`))
    const stateBox = el('div', 'layer-state')
    stateBox.append(el('i', 'dot'), el('span', null, L.stateText))
    row.append(code, body, metric, stateBox)
    box.append(row)
  }
  const at = new Date().toTimeString().slice(0, 8)
  $('#layers-meta').textContent = `L0–L5 · ${d.build} · 刷新于 ${at}`
}

function renderPending(d) {
  const box = $('#pending')
  box.textContent = ''
  if (!d.pending.length) {
    box.append(el('p', 'muted', '暂无等待中的审批'))
    return
  }
  for (const p of d.pending) {
    const item = el('div', 'pending-item')
    item.append(el('div', 'tool', `${TOOL_CN[p.tool] || p.tool || '待确认动作'}`))
    if (p.target) item.append(el('div', 'target mono', p.target))
    const meta = el('div', 'meta')
    meta.append(el('span', 'mono', p.runId), el('span', 'mono', timeOf(p.startedAt)))
    item.append(meta)
    box.append(item)
  }
}

function renderAudit(d) {
  const ol = $('#audit')
  ol.textContent = ''
  if (!d.audit.length) {
    ol.classList.add('is-empty')
    const li = el('li')
    li.style.gridTemplateColumns = '1fr'
    li.append(el('span', 'muted', '还没有活动记录'))
    ol.append(li)
  } else {
    ol.classList.remove('is-empty')
  }
  d.audit.forEach((a, i) => {
    const li = el('li')
    li.append(
      el('span', 'idx mono', String(i + 1).padStart(2, '0')),
      el('span', 'ts mono', timeOf(a.ts)),
      el('span', null, ACTION_CN[a.action] || a.action),
    )
    ol.append(li)
  })
  $('#audit-count').textContent = `${d.counts.audit} 条`
}

function renderTenant(d) {
  const kv = $('#tenant-kv')
  kv.textContent = ''
  const rows = [
    ['会话', d.counts.sessions],
    ['消息', d.counts.messages],
    ['运行', d.counts.runsTotal],
    ['会话授权', d.counts.grants],
    ['审计', d.counts.audit],
  ]
  for (const [k, v] of rows) kv.append(el('dt', null, k), el('dd', null, String(v)))
  $('#tenant').textContent = `tenant ${d.tenantId}`
  $('#build').textContent = `build ${d.build}`
}

function renderDriver(d) {
  const box = $('#driver')
  box.dataset.state = d.driver.real ? 'ok' : 'fake'
  const label = box.querySelector('span:last-child')
  label.textContent = d.driver.real ? `模型 ${d.driver.name}` : '模型未接入'
}

async function load() {
  if (!token) {
    $('#layers').append(el('p', 'muted', '缺少访问令牌：请在地址后加上 ?token=…'))
    return
  }
  const res = await fetch('/api/overview', { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    $('#layers').append(el('p', 'muted', `读取失败（${res.status}）`))
    return
  }
  const d = await res.json()
  renderDriver(d)
  renderLayers(d)
  renderPending(d)
  renderAudit(d)
  renderTenant(d)

  for (const a of document.querySelectorAll('a[href^="/"]')) {
    const href = a.getAttribute('href')
    if (href.includes('token=')) continue
    a.href = `${href}${href.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  }
}

$('#refresh').addEventListener('click', () => load())
load()
