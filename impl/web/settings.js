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
    row('单 run 步数上限', body.agent?.maxSteps ? `${body.agent.maxSteps} 步` : '-'),
    row('单 run 超时', body.agent?.timeoutMs ? `${(body.agent.timeoutMs / 1000).toFixed(0)} 秒` : '-'),
    row('历史带入条数', body.agent?.historyLimit ? `${body.agent.historyLimit} 条` : '-'),
    row('限流 api / runs / upgrade / login', [body.limits?.api?.limit, body.limits?.runs?.limit, body.limits?.upgrade?.limit, body.limits?.login?.limit].map((n) => `${n}/分`).join(' · '))
  )
  // 模型连通性探针：接上 key 后先"试一句"，再跑真任务
  const probeRow = document.createElement('div')
  probeRow.className = 'set-row'
  const k = document.createElement('div'); k.className = 'set-key'; k.textContent = '模型连通性'
  const v = document.createElement('div'); v.className = 'set-val'
  const btn = document.createElement('button'); btn.className = 'btn'; btn.id = 'probe'; btn.textContent = '测试连接'
  const out = document.createElement('span'); out.id = 'probe-out'; out.style.marginLeft = '10px'
  btn.addEventListener('click', async () => {
    btn.disabled = true; out.textContent = '测试中…'
    try {
      const r = await fetch('/api/model/probe', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })
      const j = await r.json().catch(() => ({}))
      if (r.status === 200 && j.ok) out.textContent = `✔ ${j.driver} · ${j.ms}ms · ${JSON.stringify(j.sample)}`
      else if (j.error === 'driver_is_stub') out.textContent = '桩驱动：先配置 MODEL_* 并重启'
      else out.textContent = `�� 失败：${j.message ?? j.error ?? r.status}`
    } catch (e) {
      out.textContent = '✖ 网络错误'
    } finally {
      btn.disabled = false
    }
  })
  v.append(btn, out)
  probeRow.append(k, v)

  const note = document.createElement('p')
  note.className = 'muted'
  note.textContent = '这里不展示令牌、口令、模型密钥与数据库绝对路径。'
  list.append(probeRow, note)
}
main()
