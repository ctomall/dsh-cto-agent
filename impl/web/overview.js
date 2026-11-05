// 总览页：语言参照 DSH Web（冷中性阶 + 发丝线 + 层叠卡片）。
// 数据来自 /api/overview；缺口数据来自 CONFORMANCE.md 对账结果。
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
  cross_tenant_denied: '跨租户访问被拒',
  session_grant: '命中会话授权',
}

const GAPS = [
  ['数据表', '6 张'],
  ['事件类型', '3 类'],
  ['前端路由', '6 条'],
  ['Skill · 知识库 · 插件', '未实现'],
]

const timeOf = (iso) => String(iso || '').slice(11, 19) || '—'

function layerRows(d) {
  const r = d.counts.runs || {}
  const waiting = r.waiting_approval || 0
  const running = r.running || 0
  return [
    { code: 'L0', name: 'Host Shell', cn: '页面与资源', desc: '工作台 · 总览 · 静态资源', num: '2', unit: '页', tag: 'ok', tagText: '在线' },
    { code: 'L1', name: 'Gateway', cn: '网关', desc: '鉴权 · 限流 · 路由 · 租户隔离', num: '14', unit: '路由', tag: 'ok', tagText: '正常' },
    {
      code: 'L2', name: 'Kernel', cn: '内核', desc: '事件总线 · 模型驱动 · 工具策略',
      num: d.driver.real ? '1' : '0', unit: d.driver.real ? '模型' : '真实模型',
      tag: d.driver.real ? 'ok' : 'gap', tagText: d.driver.real ? '已接入' : '桩',
    },
    {
      code: 'L3', name: 'Runs', cn: '运行', desc: '状态机 · 审批挂起 · 取消',
      num: String(waiting + running), unit: '进行中',
      tag: waiting ? 'wait' : 'ok', tagText: waiting ? `${waiting} 待审批` : '空闲',
    },
    { code: 'L4', name: 'Tools', cn: '工具与授权', desc: 'fs.read · fs.write · 会话授权', num: String(d.counts.grants), unit: '授权', tag: 'ok', tagText: '正常' },
    { code: 'L5', name: 'Storage', cn: '存储', desc: '会话 · 消息 · 审计 · 事件', num: String(d.counts.messages), unit: '消息', tag: 'ok', tagText: '正常' },
  ]
}

function renderLayers(d) {
  const box = $('#layers')
  box.textContent = ''
  for (const L of layerRows(d)) {
    const row = el('div', 'row')
    row.append(el('div', 'code', L.code))

    const body = el('div')
    const name = el('div', 'name', L.name)
    name.append(el('span', 'cn', L.cn))
    body.append(name, el('div', 'desc', L.desc))

    const metric = el('div', 'metric')
    metric.append(document.createTextNode(L.num), el('span', 'unit', ` ${L.unit}`))

    const tag = el('span', `tag ${L.tag}`)
    tag.append(el('i', 'dot'), el('span', null, L.tagText))

    row.append(body, metric, tag)
    box.append(row)
  }
  $('#layers-meta').textContent = `L0–L5 · ${d.build}`
  const pill = $('#driver')
  pill.className = `pill ${d.driver.real ? 'is-ok' : 'is-warn'}`
  pill.querySelector('span').textContent = d.driver.real ? d.driver.name : '模型未接入'
}

function renderGaps() {
  const box = $('#gaps')
  box.className = 'rows rows-gap'
  box.textContent = ''
  for (const [label, count] of GAPS) {
    const row = el('div', 'row')
    row.append(el('i', 'dot'), el('span', 'label', label), el('span', 'count', count))
    box.append(row)
  }
  $('#gaps-meta').textContent = `${GAPS.length} 处`
}

function renderAudit(d) {
  const box = $('#audit')
  box.className = 'rows rows-audit'
  box.textContent = ''
  if (!d.audit.length) {
    box.append(el('div', 'empty', '还没有活动记录'))
  } else {
    d.audit.forEach((a, i) => {
      const row = el('div', 'row')
      row.append(
        el('span', 'no', String(i + 1).padStart(2, '0')),
        el('time', null, timeOf(a.ts)),
        el('span', 'act', ACTION_CN[a.action] || a.action),
      )
      box.append(row)
    })
  }
  $('#audit-count').textContent = `${d.counts.audit} 条`
}

function renderPending(d) {
  const box = $('#pending')
  box.textContent = ''
  if (!d.pending.length) box.append(el('div', 'empty', '暂无等待中的审批'))
  for (const p of d.pending) {
    const item = el('div', 'pend')
    const top = el('div', 'top')
    top.append(el('i', 'dot'), el('span', 'tool', TOOL_CN[p.tool] || p.tool || '待确认动作'))
    item.append(top)
    if (p.target) item.append(el('div', 'target', p.target))
    const meta = el('div', 'meta')
    meta.append(el('span', null, p.runId), el('span', null, timeOf(p.startedAt)))
    item.append(meta)
    box.append(item)
  }
  $('#pending-count').textContent = `${d.pending.length} 条`
}

function renderMeta(d) {
  const now = new Date()
  $('#sub').textContent = `运行 ${d.counts.runsTotal} 次 · 刷新 ${now.toTimeString().slice(0, 8)}`
  $('#build').textContent = `build ${d.build}`
  $('#tenant').textContent = `tenant ${d.tenantId}`

  const kv = $('#tenant-kv')
  kv.textContent = ''
  for (const [k, v] of [
    ['会话', d.counts.sessions],
    ['消息', d.counts.messages],
    ['运行', d.counts.runsTotal],
    ['会话授权', d.counts.grants],
    ['审计', d.counts.audit],
  ]) {
    kv.append(el('dt', null, k), el('dd', null, String(v)))
  }

  for (const a of document.querySelectorAll('a[href^="/"]')) {
    const href = a.getAttribute('href')
    if (href.includes('token=')) continue
    a.href = `${href}${href.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  }
}

async function load() {
  if (!token) {
    $('#layers').append(el('div', 'empty', '缺少访问令牌：地址后加 ?token=…'))
    return
  }
  const res = await fetch('/api/overview', { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    $('#layers').append(el('div', 'empty', `读取失败（${res.status}）`))
    return
  }
  const d = await res.json()
  renderLayers(d)
  renderGaps()
  renderAudit(d)
  renderPending(d)
  renderMeta(d)
}

$('#refresh').addEventListener('click', load)
load()
