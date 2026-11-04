// SSE 传输层：把事件写成 SSE 帧；支持 Last-Event-ID 续传。
// 语义：Last-Event-ID = 调用方已收到的最大 seq，服务端只回放 seq > last。
export function toFrame(ev) {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`
}

export function framesAfter(log, runId, lastEventId = 0) {
  const last = Number.isFinite(lastEventId) ? lastEventId : 0
  return log.after(runId, last).map(toFrame)
}

export function parseLastEventId(headerValue, queryValue) {
  const raw = headerValue ?? queryValue
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// HTTP 处理器：GET /api/runs/:id/events
export function handleEventsRequest({ res, log, runId, lastEventId, heartbeatMs = 0 }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  for (const frame of framesAfter(log, runId, lastEventId)) res.write(frame)

  // 心跳：长连接必须保活，否则代理会按空闲超时断开（注释行不触发客户端事件）
  let timer
  if (heartbeatMs > 0) {
    timer = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs)
    timer.unref?.()
  }

  res.end()
  if (timer) clearInterval(timer)
}
