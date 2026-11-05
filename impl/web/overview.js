// 系统断面：把 L0–L5 画成一张技术图纸。
// 数据来自 /api/overview（租户内只读聚合）；缺口数据来自 CONFORMANCE.md 的对账结果（硬编码但可追溯）。
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

// 文档有、代码无（对账自 CONFORMANCE.md，v33 版）
const GAPS = [
  ['数据表', '6 张'],
  ['事件类型', '3 类'],
  ['前端路由', '6 条'],
  ['Skill · 知识库 · 插件', '未实现'],
]

const timeOf = (iso) => String(iso || '').slice(11, 19) || '-'

function layers(d) {
  const r = d.counts.runs || {}
  const waiting = r.waiting_approval || 0
  const running = r.running || 0
  return [
    { code: 'L0', name: 'Host Shell', cn: '页面与资源', desc: '工作台 · 断面页 · 静态资源', val: '2 页', state: 'ok' },
    { code: 'L1', name: 'Gateway', cn: '网关', desc: '鉴权 · 限流 · 路由 · 租户隔离', val: '14 路由', state: 'ok' },
    {
      code: 'L2', name: 'Kernel', cn: '内核', desc: '事件总线 · 模型驱动 · 工具策略',
      val: d.driver.real ? d.driver.name : '桩',
      state: d.driver.real ? 'ok' : 'gap',
    },
    {
      code: 'L3', name: 'Runs', cn: '运行', desc: '状态机 · 审批挂起 · 取消',
      val: `${waiting + running} 进行中`,
      state: waiting ? 'warn' : 'ok',
    },
    { code: 'L4', name: 'Tools', cn: '工具与授权', desc: 'fs.read · fs.write · 会话授权', val: `${d.counts.grants} 授权`, state: 'ok' },
    { code: 'L5', name: 'Storage', cn: '存储', desc: '会话 · 消息 · 审计 · 事件', val: `${d.counts.messages} 消息`, state: 'ok' },
  ]
}

function renderStack(d) {
  const box = $('#layers')
  box.textContent = ''
  for (const L of layers(d)) {
    const row = el('div', 'layer')
    row.dataset.state = L.state
    const code = el('div', 'code', L.code)
    const body = el('div')
    const nm = el('div', 'nm', L.name)
    nm.append(el('span', 'cn', L.cn))
    body.append(nm, el('div', 'desc', L.desc))
    const dimLine = el('div', 'dim-line')
    dimLine.append(el('div', 'bar'), el('span', 'val', L.val))
    row.append(code, body, dimLine)
    box.append(row)
  }
  $('#stack-meta').textContent = `L0–L5 · ${d.build}`
  const stamp = $('#stamp')
  stamp.hidden = d.driver.real
}

function renderGaps() {
  const box = $('#gap-box')
  const ul = el('ul')
  for (const [k, v] of GAPS) {
    const li = el('li')
    li.append(el('span', null, k), el('span', 'dim', v))
    ul.append(li)
  }
  box.append(ul)
  $('#gaps-meta').textContent = `${GAPS.length} 处`
}

function renderPending(d) {
  const box = $('#pending')
  box.textContent = ''
  if (!d.pending.length) {
    box.append(el('p', 'dim mono', '无'))
  }
  for (const p of d.pending) {
    const item = el('div', 'item')
    item.append(el('div', 'tool', TOOL_CN[p.tool] || p.tool || '待确认动作'))
    if (p.target) item.append(el('div', 'target', p.target))
    const meta = el('div', 'meta')
    meta.append(el('span', null, p.runId), el('span', null, timeOf(p.startedAt)))
    item.append(meta)
    box.append(item)
  }
  $('#pending-count').textContent = `${d.pending.length} 条`
}

function renderLedger(d) {
  const ol = $('#audit')
  ol.textContent = ''
  if (!d.audit.length) {
    ol.classList.add('is-empty')
    const li = el('li')
    li.append(el('span', 'dim', '还没有活动'))
    ol.append(li)
  } else {
    ol.classList.remove('is-empty')
    d.audit.forEach((a, i) => {
      const li = el('li')
      li.append(
        el('span', 'no', String(i + 1).padStart(2, '0')),
        el('span', 't', timeOf(a.ts)),
        el('span', null, ACTION_CN[a.action] || a.action),
      )
      ol.append(li)
    })
  }
  $('#audit-count').textContent = `${d.counts.audit} 条`
}

function renderTitleBlock(d) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  $('#sheet-sub').textContent = `cube-agent · 分层断面 A–A · 运行 ${d.counts.runsTotal} 次 · 刷新 ${now.toTimeString().slice(0, 8)}`
  $('#tb-build').textContent = d.build
  $('#tb-tenant').textContent = d.tenantId
  $('#tb-date').textContent = date
}

async function load() {
  if (!token) {
    $('#layers').append(el('p', 'dim mono', '缺少访问令牌：地址后加 ?token=…'))
    return
  }
  const res = await fetch('/api/overview', { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    $('#layers').append(el('p', 'dim mono', `读取失败（${res.status}）`))
    return
  }
  const d = await res.json()
  renderStack(d)
  renderGaps()
  renderPending(d)
  renderLedger(d)
  renderTitleBlock(d)
}

$('#refresh').addEventListener('click', load)
load()
