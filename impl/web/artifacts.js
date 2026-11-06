// 产物页：跨会话列出本租户产物，可下载；数据来自 /api/artifacts
const token = new URLSearchParams(location.search).get('token')
const $ = (s) => document.querySelector(s)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const api = async (path) => {
  const r = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}
const fmt = (n) => (n == null ? '-' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

async function main() {
  const me = await api('/api/me')
  if (me.status === 401) { location.href = '/login'; return }
  if (me.body?.sha) $('#build').textContent = `build ${me.body.sha}`

  const drv = await api('/api/model/status')
  if (drv.status === 200) {
    $('#sbDriver').textContent = drv.body.real ? `驱动 ${drv.body.driver}` : '演示驱动（未接模型）'
    $('#sbDriver').dataset.real = drv.body.real ? '1' : '0'
  }

  const { status, body } = await api('/api/artifacts?limit=200')
  const list = $('#list')
  list.textContent = ''
  if (status !== 200) { $('#status').textContent = `读取失败（${status}）`; return }
  const items = body.artifacts || []
  $('#count').textContent = `${items.length} 个`
  $('#status').textContent = items.length ? '就绪' : '还没有产物'
  if (!items.length) { list.append(el('p', 'muted', '还没有产物')); return }

  for (const a of items) {
    const row = el('div', 'art-row')
    const left = el('div', 'art-main')
    left.append(el('div', 'art-name', a.path), el('div', 'meta', `${a.mime || '文件'} · ${fmt(a.size)} · ${a.sessionId}`))
    const right = el('div', 'art-acts')
    const dl = el('a', 'btn', '下载')
    dl.href = `/api/artifacts/${encodeURIComponent(a.runId)}/${encodeURIComponent(a.path)}${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const open = el('a', 'btn', '会话')
    open.href = `/?sid=${encodeURIComponent(a.sessionId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
    right.append(open, dl)
    row.append(left, right)
    list.append(row)
  }
}
main()
