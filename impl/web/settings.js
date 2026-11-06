// 设置页：只读展示运行时配置（不含任何密钥）
const token = new URLSearchParams(location.search).get('token')
const $ = (s) => document.querySelector(s)
const api = async (path) => {
  const r = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}
const row = (label, value) => {
  const d = document.createElement('div')
  d.className = 'set-row'
  const k = document.createElement('div'); k.className = 'set-key'; k.textContent = label
  const v = document.createElement('div'); v.className = 'set-val'; v.textContent = value
  d.append(k, v)
  return d
}

async function main() {
  const me = await api('/api/me')
  if (me.status === 401) { location.href = '/login'; return }
  const { status, body } = await api('/api/settings')
  const list = $('#list')
  list.textContent = ''
  if (status !== 200) { $('#status').textContent = `读取失败（${status}）`; return }

  $('#tenant').textContent = body.tenantId ?? '-'
  $('#sbDriver').textContent = body.driver?.real ? `驱动 ${body.driver.name}` : '演示驱动（未接模型）'
  $('#sbDriver').dataset.real = body.driver?.real ? '1' : '0'
  $('#build').textContent = `build ${body.version ?? '-'}`
  $('#status').textContent = '只读'

  list.append(
    row('模型驱动', `${body.driver?.name ?? '-'}（${body.driver?.real ? '真实' : '桩驱动'}）`),
    row('版本', body.version ?? '-'),
    row('启动时间', body.startedAt ?? '-'),
    row('工具结果保留', body.retentionDays ? `${body.retentionDays} 天` : '不清理'),
    row('请求体上限', body.maxBodyBytes ? `${(body.maxBodyBytes / 1024).toFixed(0)} KB` : '-'),
    row('升级测试门禁', body.upgrade?.testGate ? '开启（失败自动回滚）' : '关闭'),
    row('升级后自重启', body.upgrade?.exitAfter ? '开启' : '关闭'),
    row('限流 api / runs / upgrade / login', [body.limits?.api?.limit, body.limits?.runs?.limit, body.limits?.upgrade?.limit, body.limits?.login?.limit].map((n) => `${n}/分`).join(' · '))
  )
  const note = document.createElement('p')
  note.className = 'muted'
  note.textContent = '这里不展示令牌、口令、模型密钥与数据库绝对路径。'
  list.append(note)
}
main()
