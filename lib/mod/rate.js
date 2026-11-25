// 从会话事件日志折叠输出速度（dsh-go 桥接环境无逐条 chunk 事件，流以聚合块持久化：
// assistant/message.data.stream 里的 text-chunks / reasoning-chunks 带 time0 + dt[]，
// usage 在 message.data.usage（官方输出 token 计数）。
//
// 口径：速度 = usage.outputTokens ÷ 聚合块首尾跨度（实测流式时长）。
// generating = 日志里有未闭合的 step/start → 正在生成；
// 生成中显示上一步速度当估算，生成结束显示最后一步实测值，数字常驻直到下一轮覆盖。
// 若活动日志暴露逐条 assistant/chunk（text-delta），优先用它们算真·实时速度。
const approx = (text) => Math.max(1, Math.round((text.length + 3) / 4))

/** 一条 assistant/message 的输出速度：{tokens, ms, end} 或 null。 */
function messageRate(data) {
  const out = Number(data?.usage?.outputTokens ?? data?.usage?.output)
  if (!Number.isFinite(out) || out <= 0) return null
  const blocks = []
  for (const record of Array.isArray(data?.stream) ? data.stream : []) {
    const c = record?.chunk ?? record
    // 跨度必须含 tool-call-chunks：usage.outputTokens 包含工具调用参数的 token，
    // 只算 text/reasoning 会让工具调用为主的步骤虚高数倍甚至百倍
    if (c?.type !== 'text-chunks' && c?.type !== 'reasoning-chunks' && c?.type !== 'tool-call-chunks') continue
    const time0 = Number(c.time0)
    const dt = Array.isArray(c.dt) ? c.dt : []
    if (!Number.isFinite(time0) || dt.length === 0) continue
    blocks.push({ start: time0, end: time0 + dt.reduce((a, b) => a + (Number(b) || 0), 0) })
  }
  if (blocks.length === 0) return null
  const start = Math.min(...blocks.map((b) => b.start))
  const end = Math.max(...blocks.map((b) => b.end))
  const ms = end - start
  if (!(ms > 200)) return null
  return { tokens: out, ms, end }
}

export function foldRate(events, now = Date.now()) {
  let last = null
  let generating = false
  // 整轮加权平均：当前 turn 内所有 message 的 tokens 求和 ÷ 各自时长求和
  let turnTokens = 0
  let turnMs = 0
  let currentTurn = null
  // 末尾逐块增量（若活动日志暴露 assistant/chunk，可算真·实时速度；否则恒为空）
  let chunkTokens = 0
  let chunkFirstAt = null
  let chunkLastAt = null
  for (const e of events || []) {
    const t = e?.type
    const at = e?.time
    if (t === 'turn/start') {
      generating = true
      currentTurn = e?.data?.turn ?? null
      turnTokens = 0
      turnMs = 0
    } else if (t === 'turn/end') {
      generating = false
    } else if (t === 'step/start') {
      generating = true
    } else if (t === 'step/end') {
      generating = false
    } else if (t === 'assistant/message') {
      const rate = messageRate(e.data)
      if (rate) {
        last = rate
        if (currentTurn === null || e?.data?.turn === currentTurn) {
          turnTokens += rate.tokens
          turnMs += rate.ms
        }
      }
      chunkTokens = 0
      chunkFirstAt = null
      chunkLastAt = null
    } else if (t === 'assistant/chunk') {
      const c = e?.data?.chunk
      if ((c?.type === 'text-delta' || c?.type === 'reasoning-delta') && typeof c.text === 'string' && c.text.length > 0 && Number.isFinite(at)) {
        chunkTokens += approx(c.text)
        chunkFirstAt ??= at
        chunkLastAt = at
      }
    }
  }
  const stepSpeed = last ? last.tokens / (last.ms / 1000) : 0
  const turnSpeed = turnMs > 0 ? turnTokens / (turnMs / 1000) : stepSpeed
  // 真·实时：末尾增量块新鲜（3 秒内）且累计 ≥500ms
  if (chunkTokens > 0 && chunkLastAt !== null && chunkFirstAt !== null && now - chunkLastAt < 3000 && chunkLastAt - chunkFirstAt >= 500) {
    return { speed: chunkTokens / ((chunkLastAt - chunkFirstAt) / 1000), live: true, lastChange: chunkLastAt, generating: true, turnSpeed, realtime: true }
  }
  if (last === null) return { speed: 0, live: generating, lastChange: 0, generating, turnSpeed: 0, realtime: false }
  return { speed: stepSpeed, live: generating, lastChange: last.end, generating, turnSpeed, realtime: false }
}
