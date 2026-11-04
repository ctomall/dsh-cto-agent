// 极简 Prometheus 文本指标：不引入依赖，够用来回答"线上到底在发生什么"。
export function createMetrics() {
  const counters = new Map() // key -> {name, labels, value}
  const gauges = new Map()

  const keyOf = (name, labels) =>
    `${name}{${Object.keys(labels).sort().map((k) => `${k}="${labels[k]}"`).join(',')}}`

  const bump = (map, name, labels = {}, delta = 1) => {
    const k = keyOf(name, labels)
    const cur = map.get(k) ?? { name, labels, value: 0 }
    cur.value += delta
    map.set(k, cur)
  }

  return {
    inc(name, labels = {}, delta = 1) {
      bump(counters, name, labels, delta)
    },
    set(name, labels = {}, value = 0) {
      const k = keyOf(name, labels)
      gauges.set(k, { name, labels, value })
    },
    render() {
      const lines = []
      const emit = (map, type) => {
        const byName = new Map()
        for (const { name, labels, value } of map.values()) {
          if (!byName.has(name)) byName.set(name, [])
          byName.get(name).push({ labels, value })
        }
        for (const [name, rows] of byName) {
          lines.push(`# TYPE ${name} ${type}`)
          for (const r of rows) {
            const lbl = Object.keys(r.labels).length
              ? `{${Object.keys(r.labels).sort().map((k) => `${k}="${r.labels[k]}"`).join(',')}}`
              : ''
            lines.push(`${name}${lbl} ${r.value}`)
          }
        }
      }
      emit(counters, 'counter')
      emit(gauges, 'gauge')
      return lines.join('\n') + '\n'
    },
  }
}
