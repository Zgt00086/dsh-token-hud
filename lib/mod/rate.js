// 从会话事件日志折叠输出速度（dsh-go 桥接环境无逐条 chunk 事件，流以聚合块持久化：
// assistant/message.data.stream 里的 text-chunks / reasoning-chunks 带 time0 + dt[]，
// usage 在 message.data.usage.outputTokens）。
//
// 口径：速度 = outputTokens ÷ 真实耗时（step/start → 消息落盘）。
// 为什么不用 dt[] 跨度：dt 只覆盖首字之后的流式段，漏掉 TTFT（实测 2–8 秒），
// 小消息会算出 400–580 tok/s 的假速度（真会话 637 条实测：dt 法中位 101.6，
// 墙钟法中位 23.4、大输出 47，才符合 DeepSeek 实际）。跨度仅用于确认"确实流过式"。
// generating = 日志里有未闭合的 step/start → 正在生成；
// 生成中显示上一步速度当估算，生成结束显示最后一步实测值，数字常驻直到下一轮覆盖。
const MIN_WALL_MS = 800 // 太短样本抖动大，不报
const MAX_WALL_MS = 90_000 // 排队/重试退避造成几万毫秒的异常样本，不报

/** 一条 assistant/message 的输出速度：{tokens, ms, end} 或 null。 */
function messageRate(data, beginAt, endAt) {
  const out = Number(data?.usage?.outputTokens ?? data?.usage?.output)
  if (!Number.isFinite(out) || out <= 0) return null
  let lo = Infinity
  for (const record of Array.isArray(data?.stream) ? data.stream : []) {
    const c = record?.chunk ?? record
    // 必须有流式块：tool-call-chunks 也算（usage.outputTokens 含工具调用参数）
    if (c?.type !== 'text-chunks' && c?.type !== 'reasoning-chunks' && c?.type !== 'tool-call-chunks') continue
    const time0 = Number(c.time0)
    const dt = Array.isArray(c.dt) ? c.dt : []
    if (!Number.isFinite(time0) || dt.length === 0) continue
    lo = Math.min(lo, time0)
  }
  if (!Number.isFinite(lo)) return null
  const wall = endAt - beginAt
  if (!Number.isFinite(wall) || wall < MIN_WALL_MS || wall > MAX_WALL_MS) return null
  return { tokens: out, ms: wall, end: endAt }
}

export function foldRate(events, now = Date.now()) {
  let last = null
  let generating = false
  // 整轮加权平均：当前 turn 内所有 message 的 tokens 求和 ÷ 各自时长求和
  let turnTokens = 0
  let turnMs = 0
  let currentTurn = null
  // 当前这次请求的起点：step/start，遇到重试则后移到重试起点
  let beginAt = null
  for (const e of events || []) {
    const t = e?.type
    const at = e?.time
    if (t === 'turn/start') {
      generating = true
      currentTurn = e?.data?.turn ?? null
      turnTokens = 0
      turnMs = 0
      beginAt = null
    } else if (t === 'turn/end') {
      generating = false
    } else if (t === 'step/start') {
      generating = true
      beginAt = Number.isFinite(at) ? at : null
    } else if (t === 'step/end') {
      generating = false
    } else if ((t === 'llm/retry' || t === 'llm/retry-started') && Number.isFinite(at)) {
      // 重试等于重新计时，早于重试的等待不算生成耗时
      beginAt = Math.max(beginAt ?? at, at)
    } else if (t === 'assistant/message') {
      const rate = beginAt === null ? null : messageRate(e.data, beginAt, Number(at))
      if (rate) {
        last = rate
        if (currentTurn === null || e?.data?.turn === currentTurn) {
          turnTokens += rate.tokens
          turnMs += rate.ms
        }
      }
    }
  }
  const stepSpeed = last ? last.tokens / (last.ms / 1000) : 0
  const turnSpeed = turnMs > 0 ? turnTokens / (turnMs / 1000) : stepSpeed
  if (last === null) return { speed: 0, live: generating, lastChange: 0, generating, turnSpeed: 0, realtime: false }
  return { speed: stepSpeed, live: generating, lastChange: last.end, generating, turnSpeed, realtime: false }
}
