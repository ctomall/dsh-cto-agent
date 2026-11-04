// SSE 传输层：回放 + 订阅实时事件；Last-Event-ID = 调用方已收到的最大 seq。
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

function writeHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
}

// 只回放、不保持连接（测试与一次性读取用）
export function handleEventsRequest({ res, log, runId, lastEventId, heartbeatMs = 0 }) {
  writeHead(res)
  for (const frame of framesAfter(log, runId, lastEventId)) res.write(frame)
  let timer
  if (heartbeatMs > 0) {
    timer = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs)
    timer.unref?.()
  }
  res.end()
  if (timer) clearInterval(timer)
}

// 回放 + 订阅：先补历史，再持续推送，直到客户端断开或 run 终止
export function handleLiveEvents({ req, res, log, rc, runId, lastEventId, heartbeatMs = 15000 }) {
  writeHead(res)
  for (const frame of framesAfter(log, runId, lastEventId)) res.write(frame)

  const onEvent = (ev) => {
    res.write(toFrame(ev))
    if (ev.type === 'run.finished' || ev.type === 'run.failed' || ev.type === 'run.canceled') {
      cleanup()
      res.end()
    }
  }
  rc.bus.on(runId, onEvent)

  const timer = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs)
  timer.unref?.()

  function cleanup() {
    clearInterval(timer)
    rc.bus.off(runId, onEvent)
  }
  req.on('close', cleanup)

  // run 已是终态则无后续事件，直接结束
  const status = rc.status(runId)
  if (status === 'done' || status === 'failed' || status === 'canceled') {
    cleanup()
    res.end()
  }
}
