// reasonix-token-hud-dshgo — native dsh-go HUD for the current session's token
// usage, context occupancy, estimated CNY cost and account balance.
//
// The dsh-go app draws the manifest surfaces; this file only folds the live
// session's event log and emits strip / panel data. It reuses the same
// replacement + retry semantics as dsh-token-meter's `tokenUsage` projection,
// but keeps per-sample timestamps and models so the peak / off-peak split is
// exact instead of "price everything at now".
import { foldRate } from './mod/rate.js'
import { MikuClient, loadAccount, saveToken, readToken, clearToken, showNum, parsePeakWindow } from './mod/miku.js'
import { readFile } from 'node:fs/promises'

export const name = 'local-token-hud'

const TICK_MS = 3000
const BALANCE_TTL_MS = 5 * 60 * 1000
const RATES = { input: 2, cacheRead: 0.04, output: 8 } // CNY / 1M peak tokens
const HALF = 0.5

const miku = new MikuClient()
const account = loadAccount(miku)

const MODELS_TTL = 10 * 60_000
const modelsCache = { at: 0, rows: [] }
// 峰谷时段与官方价优先用站点配置
const siteState = { ranges: null, weekdaysOnly: true, official: null }
const officialState = { at: 0, text: '—', amount: null, tone: undefined }

function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key, false) : undefined
  } catch {
    return undefined
  }
}

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const totalOf = (b) => b.uncachedInput + b.cacheRead + b.cacheWrite + b.output

function peakRanges() {
  return siteState.ranges ?? [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
}

/** 峰谷判定：时段来自站点 /api/site-config，默认北京时间工作日 09–12、14–18。 */
function tierAt(time) {
  const t = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const d = new Date(t + 8 * 60 * 60 * 1000)
  const day = d.getUTCDay()
  if (siteState.weekdaysOnly && (day === 0 || day === 6)) return 'off'
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return peakRanges().some(([a, b]) => minutes >= a && minutes < b) ? 'peak' : 'off'
}

/** 官方价（站点配置优先，回退内置）。 */
function officialPrice(tier) {
  const o = siteState.official
  const p = o ? (tier === 'off' ? o.offPeak : o.peak) : null
  const factor = tier === 'off' ? HALF : 1
  const pick = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback * factor)
  return {
    input: pick(p?.inputMiss, RATES.input),
    cacheRead: pick(p?.inputHit, RATES.cacheRead),
    output: pick(p?.output, RATES.output)
  }
}

/** 这条记录是否走中转站（官方与中转分开记账）。 */
function isRelay(provider, model) {
  const p = String(provider || '').toLowerCase()
  if (p.includes('mikumc') || p.includes('miku') || p.includes('君邪')) return true
  if (p.includes('deepseek')) return false
  return Boolean(modelsCache.rows.some((r) => r.name === model || r.id === model))
}

/** 单价：中转用站点实价，官方用官方价；中转旧站模型无价时返回 null（不计价）。 */
function priceFor(provider, model, tier) {
  if (isRelay(provider, model)) {
    const hit = modelsCache.rows.find((r) => r.name === model || r.id === model)
    const p = hit?.pricing ? (tier === 'off' ? hit.pricing.offPeak : hit.pricing.peak) : null
    if (p && p.inputMiss !== null && p.output !== null) {
      return { input: p.inputMiss, cacheRead: p.inputHit ?? p.inputMiss, output: p.output }
    }
    return null
  }
  return officialPrice(tier)
}

function costOfBucket(b, price = priceFor(b.provider, b.model, b.tier)) {
  if (!price) return null
  return ((b.uncachedInput + b.cacheWrite) * price.input + b.cacheRead * price.cacheRead + b.output * price.output) / 1e6
}

function savedOfBucket(b, price = priceFor(b.provider, b.model, b.tier)) {
  if (!price) return 0
  return Math.max(0, b.cacheRead * (price.input - price.cacheRead)) / 1e6
}

function streamUsage(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage) return record.chunk.usage
  }
  return null
}

function usageOf(event) {
  if (event === null || typeof event !== 'object') return null
  const data = event.data ?? {}
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk
    if (!chunk || chunk.type !== 'usage' || !chunk.usage) return null
    return { turn: data.turn, step: data.step, time: event.time, usage: chunk.usage }
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  const usage = data.usage ?? streamUsage(data.stream)
  if (!usage) return null
  return { turn: data.turn, step: data.step, time: event.time, usage }
}

const bucketsOf = (usage) => ({
  uncachedInput: num(usage.inputTokens ?? usage.uncachedInputTokens),
  cacheRead: num(usage.cacheReadTokens),
  cacheWrite: num(usage.cacheWriteTokens),
  output: num(usage.outputTokens)
})

function addTotals(totals, b, sign) {
  totals.uncachedInput = Math.max(0, totals.uncachedInput + sign * b.uncachedInput)
  totals.cacheRead = Math.max(0, totals.cacheRead + sign * b.cacheRead)
  totals.cacheWrite = Math.max(0, totals.cacheWrite + sign * b.cacheWrite)
  totals.output = Math.max(0, totals.output + sign * b.output)
  totals.requests = Math.max(0, totals.requests + sign)
}

const bucketKey = (rec) => `${rec.provider ?? ''}\u0000${rec.model ?? ''}\u0000${rec.tier}`

function addBucket(map, rec, sign) {
  const key = bucketKey(rec)
  const previous = map.get(key)
  const next = {
    provider: rec.provider ?? null,
    model: rec.model ?? null,
    tier: rec.tier,
    uncachedInput: Math.max(0, (previous?.uncachedInput ?? 0) + sign * rec.uncachedInput),
    cacheRead: Math.max(0, (previous?.cacheRead ?? 0) + sign * rec.cacheRead),
    cacheWrite: Math.max(0, (previous?.cacheWrite ?? 0) + sign * rec.cacheWrite),
    output: Math.max(0, (previous?.output ?? 0) + sign * rec.output)
  }
  if (totalOf(next) === 0) map.delete(key)
  else map.set(key, next)
}

function emptyUsage() {
  return {
    tokens: 0,
    cost: 0,
    saved: 0,
    cacheHit: null,
    contextPct: null,
    contextWindow: null,
    lastPrompt: null,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    turnCost: 0,
    turnTokens: 0,
    officialCost: 0,
    relayCost: 0,
    turnOfficialCost: 0,
    turnRelayCost: 0,
    unpricedTokens: 0,
    turnUnpricedTokens: 0,
    peakTokens: 0,
    offTokens: 0,
    models: []
  }
}

/**
 * Fold the complete live session log into one usage summary.
 * @param {object | undefined} session - live Session object.
 * @returns usage summary.
 */
function foldSession(session) {
  const summary = emptyUsage()
  if (!session || typeof session.snapshotEvents !== 'function') return summary

  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return summary
  }
  if (!Array.isArray(events)) return summary

  const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
  const buckets = new Map()
  const turnBuckets = new Map()
  let turnNo = null
  let last = null
  let origin = null
  let contextWindow = null
  let lastPrompt = null

  for (const event of events) {
    try {
      if (event.type === 'request/header') {
        const config = event.data?.header?.config
        if (config && typeof config.model === 'string' && config.model !== '') {
          origin = { provider: config.provider ?? null, model: config.model }
        }
        continue
      }
      if (event.type === 'request/context') {
        const data = event.data ?? {}
        if (typeof data.contextWindow === 'number' && data.contextWindow > 0) contextWindow = data.contextWindow
        if (typeof data.model === 'string' && data.model !== '') {
          origin = { provider: data.provider ?? null, model: data.model }
        }
        continue
      }
      if (event.type === 'llm/retry-started') {
        if (last && last.turn === event.data?.turn && last.step === event.data?.step) last = null
        continue
      }
      const sample = usageOf(event)
      if (!sample) continue
      if (!Number.isInteger(sample.turn) || !Number.isInteger(sample.step)) continue
      const b = bucketsOf(sample.usage)
      if (totalOf(b) === 0) continue
      const rec = {
        turn: sample.turn,
        step: sample.step,
        time: typeof sample.time === 'number' ? sample.time : null,
        provider: origin?.provider ?? null,
        model: origin?.model ?? null,
        tier: tierAt(typeof sample.time === 'number' ? sample.time : Date.now()),
        ...b
      }
      if (turnNo !== rec.turn) {
        turnBuckets.clear()
        turnNo = rec.turn
      }
      if (last && last.turn === rec.turn && last.step === rec.step) {
        addTotals(totals, last, -1)
        addBucket(buckets, last, -1)
        addBucket(turnBuckets, last, -1)
      }
      addTotals(totals, rec, 1)
      addBucket(buckets, rec, 1)
      addBucket(turnBuckets, rec, 1)
      last = rec
      lastPrompt = b.uncachedInput + b.cacheRead + b.cacheWrite
    } catch {
      // A malformed event must never break the HUD.
    }
  }

  summary.uncachedInput = totals.uncachedInput
  summary.cacheRead = totals.cacheRead
  summary.cacheWrite = totals.cacheWrite
  summary.output = totals.output
  summary.requests = totals.requests
  summary.tokens = totalOf(totals)
  summary.contextWindow = contextWindow
  summary.lastPrompt = lastPrompt
  summary.contextPct =
    lastPrompt !== null && contextWindow !== null ? Math.min(100, (lastPrompt / contextWindow) * 100) : null

  const inputBase = totals.uncachedInput + totals.cacheRead + totals.cacheWrite
  summary.cacheHit = inputBase > 0 ? (totals.cacheRead / inputBase) * 100 : null

  const models = new Map()
  for (const bucket of buckets.values()) {
    const bucketCost = costOfBucket(bucket)
    if (bucketCost === null) {
      summary.unpricedTokens += totalOf(bucket)
      continue
    }
    summary.cost += bucketCost
    summary.saved += savedOfBucket(bucket)
    if (isRelay(bucket.provider, bucket.model)) summary.relayCost += bucketCost
    else summary.officialCost += bucketCost
    if (bucket.tier === 'off') summary.offTokens += totalOf(bucket)
    else summary.peakTokens += totalOf(bucket)
    const name = bucket.model ?? '未知模型'
    const model = models.get(name) ?? { name, tokens: 0, cost: 0 }
    model.tokens += totalOf(bucket)
    model.cost += bucketCost
    models.set(name, model)
  }
  summary.models = [...models.values()].sort((a, b) => b.cost - a.cost)

  // 本轮（最近一个 turn）
  for (const bucket of turnBuckets.values()) {
    const bucketCost = costOfBucket(bucket)
    summary.turnTokens += totalOf(bucket)
    if (bucketCost === null) {
      summary.turnUnpricedTokens += totalOf(bucket)
      continue
    }
    summary.turnCost += bucketCost
    if (isRelay(bucket.provider, bucket.model)) summary.turnRelayCost += bucketCost
    else summary.turnOfficialCost += bucketCost
  }
  return summary
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtMoney(value) {
  const n = Number(value) || 0
  if (n === 0) return '¥0.00'
  if (n < 0.01) return '¥' + n.toFixed(4)
  if (n < 1) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(2)
}

function fmtCostShort(value) {
  const n = Number(value) || 0
  if (n === 0) return '¥0'
  if (n < 0.01) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(2)
}

function fmtTokens(value) {
  const n = Number(value) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K'
  return String(Math.round(n))
}

function fmtExact(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US')
}

function fmtPct(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value) || 0
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%'
}

function fmtBalance(amount, currency) {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' || !currency ? '¥' : currency + ' '
  const n = Math.abs(Number(amount) || 0)
  const text = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (Number(amount) < 0 ? '-' : '') + symbol + text
}

function fmtBalanceShort(amount, currency) {
  const symbol = currency === 'USD' ? '$' : '¥'
  const n = Math.abs(Number(amount) || 0)
  if (n >= 10) return symbol + n.toFixed(0)
  if (n >= 1) return symbol + n.toFixed(1)
  return symbol + n.toFixed(2)
}

// ── 官方 DeepSeek 余额（引擎服务，取不到显示 —）─────────────────────────────
function normalizeOfficial(value) {
  if (!value || value.status !== 'ready' || !Array.isArray(value.value)) return null
  const wallets = value.value
    .map((w) => ({ currency: w?.currency, amount: Number(w?.balance) }))
    .filter((w) => Number.isFinite(w.amount))
  if (wallets.length === 0) return null
  const chosen = wallets.find((w) => w.currency === 'CNY') ?? wallets[0]
  const bonus = (Array.isArray(value.bonusWallets) ? value.bonusWallets : [])
    .filter((w) => w?.currency === chosen.currency)
    .reduce((sum, w) => sum + (Number(w?.balance) || 0), 0)
  return { amount: chosen.amount + bonus, currency: chosen.currency }
}

async function refreshOfficial(ctx, caps) {
  const svc = service(ctx, 'deepseekAccount')
  if (!svc || typeof svc.getBalance !== 'function') return
  if (Date.now() - officialState.at < BALANCE_TTL_MS) return
  try {
    const picked = normalizeOfficial(await svc.getBalance({
      version: '0.2.1',
      locale: caps?.locale || 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
    }))
    officialState.at = Date.now()
    if (!picked) return
    officialState.amount = picked.amount
    officialState.text = fmtBalance(picked.amount, picked.currency)
  } catch {
    officialState.at = Date.now()
  }
}

// ── 本站模型与峰谷配置（实时拉取，不预设）──────────────────────────────────
async function liveModels() {
  if (modelsCache.rows.length && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.rows
  try {
    const [rows, site] = await Promise.all([miku.models(), miku.site().catch(() => null)])
    if (rows.length) {
      modelsCache.rows = rows
      modelsCache.at = Date.now()
    }
    if (site) {
      const ranges = parsePeakWindow(site.peakWindow)
      if (ranges) siteState.ranges = ranges
      siteState.weekdaysOnly = !/每天|每日/.test(site.peakWindow || '')
      if (site.official?.peak && site.official?.offPeak) siteState.official = site.official
    }
  } catch {
    // 接口临时不可达：保留上次列表与时段
  }
  return modelsCache.rows
}

// ── session lookup + short cache ─────────────────────────────────────────────
let usageCache = { sessionId: null, at: 0, value: null }
let rateCache = { sessionId: null, at: 0, value: null }

function computeRate(ctx, sessionId) {
  if (!sessionId) return { speed: 0, live: false, lastChange: 0 }
  const now = Date.now()
  if (rateCache.sessionId === sessionId && now - rateCache.at < 1000) return rateCache.value
  const sessions = service(ctx, 'sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  let events = null
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : null
  } catch {
    events = null
  }
  const value = foldRate(events)
  rateCache = { sessionId, at: now, value }
  return value
}

function computeUsage(ctx, sessionId) {
  if (!sessionId) return emptyUsage()
  const now = Date.now()
  if (usageCache.sessionId === sessionId && now - usageCache.at < 1000 && usageCache.prices === modelsCache.at) {
    return usageCache.value
  }
  const sessions = service(ctx, 'sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  const value = foldSession(session)
  usageCache = { sessionId, at: now, value, prices: modelsCache.at }
  return value
}

function fmtSpeed(rate) {
  if (!rate || !(rate.speed > 0)) return null
  return `${rate.speed >= 100 ? Math.round(rate.speed) : rate.speed.toFixed(1)} tok/s`
}

function fmtTurnSpeed(rate) {
  if (!rate || !(rate.turnSpeed > 0)) return null
  // 整轮与单步几乎相同时不重复显示
  if (Math.abs(rate.turnSpeed - rate.speed) < 0.05) return null
  return `${rate.turnSpeed >= 100 ? Math.round(rate.turnSpeed) : rate.turnSpeed.toFixed(1)} tok/s`
}

// ── dsh-go surfaces ──────────────────────────────────────────────────────────
function stripText(usage, rate, acc) {
  const bal = acc?.balance && acc.balance !== '—' ? ` · 余${acc.balance}` : ''
  // 生成中：速度优先；无本会话用量：显示余额；否则费用+token+余额
  if (rate?.speed > 0 && (rate.live || usage?.tokens === 0)) {
    const s = `${fmtSpeed(rate)}${rate.live ? '≈' : ''}`
    return `${s}${bal}`.length <= 24 ? `${s}${bal}` : s
  }
  if (!usage || usage.tokens === 0) {
    if (acc?.balance && acc.balance !== '—') return `余额 ${acc.balance}`.slice(0, 24)
    return acc?.username ? '等待用量' : '面板登录'
  }
  const base = `${fmtCostShort(usage.cost)} · ${fmtTokens(usage.tokens)}`
  const withBal = `${base}${bal}`
  if (withBal.length <= 24) return withBal
  return base.length <= 24 ? `${base} tok` : base.slice(0, 24)
}

function panelData(usage, rate, acc, models) {
  const pct = usage.contextPct
  const speed = fmtSpeed(rate)
  const loggedIn = Boolean(acc?.username)
  const m = (v) => (v === null || v === undefined ? '—' : fmtTokens(v))
  return {
    // 官方归官方、中转归中转
    officialItems: [
      ['余额', officialState.text],
      ['本轮消耗', fmtMoney(usage.turnOfficialCost)],
      ['本会话消耗', fmtMoney(usage.officialCost)]
    ],
    relayItems: [
      ['余额', acc?.balance ?? '—'],
      ['本轮消耗', fmtMoney(usage.turnRelayCost)],
      ['本会话消耗', fmtMoney(usage.relayCost)]
    ],
    // 会话概况
    tokens: fmtTokens(usage.tokens),
    cacheHit: fmtPct(usage.cacheHit),
    speed: rate?.live
      ? (speed ? `${speed} · ${rate.realtime ? '实时' : '估算'}` : '生成中…')
      : speed ? `${speed} · 本轮` : '生成后显示',
    speedCaption: rate?.lastChange > 0
      ? new Date(rate.lastChange).toLocaleTimeString('zh-CN', { hour12: false }) + ' · 实测'
      : '',
    contextPct: pct === null ? 0 : Math.round(pct),
    contextText:
      usage.lastPrompt !== null && usage.contextWindow !== null
        ? `${fmtTokens(usage.lastPrompt)} / ${fmtTokens(usage.contextWindow)}`
        : '等待请求',
    contextTone: pct === null ? 'info' : pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'good',
    // 账户
    accountItems: [
      ['今日消耗', acc?.todayCost ?? '—'],
      ['累计消耗', acc?.totalCost ?? '—'],
      ['今日请求', showNum(acc?.todayRequests)],
      ['今日 / 累计 Token', `${m(acc?.todayTokens)} / ${m(acc?.totalTokens)}`],
      ['今日输入', m(acc?.todayInput)],
      ['今日输出', m(acc?.todayOutput)],
      ['今日缓存命中', m(acc?.todayCached)],
      ['累计请求', showNum(acc?.totalRequests)],
      ['读数时间', acc?.checkedAt ? new Date(acc.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—']
    ],
    loginLabel: loggedIn ? `已登录 ${acc.username}` : '未登录：展开下方「登录 / 切换账号」',
    loginTone: loggedIn ? 'good' : 'warn',
    // 拆分明细
    breakdown: [
      ['未缓存输入', fmtExact(usage.uncachedInput)],
      ['缓存读取', fmtExact(usage.cacheRead)],
      ['缓存写入', fmtExact(usage.cacheWrite)],
      ['输出', fmtExact(usage.output)]
    ],
    modelItems: models.length
      ? models.map((x) => ({ title: x.name, subtitle: `${x.multiplier} · 输入 ${x.input} / 输出 ${x.output}` }))
      : [{ title: '读取中…', subtitle: '正在从本站拉取模型列表' }],
    tiers: [
      ['高峰 tokens', fmtTokens(usage.peakTokens)],
      ['空闲 tokens', fmtTokens(usage.offTokens)],
      ['计费请求', `${usage.requests} 次`],
      ['缓存节省', fmtMoney(usage.saved)],
      ['本会话模型', usage.models.length ? usage.models.map((x) => x.name).slice(0, 3).join('、') : '—']
    ],
    priceNote: [
      models.length ? '官方按官方价 · 中转按本站实价' : '官方按官方价（本站模型未取到）',
      usage.unpricedTokens > 0 ? `${fmtTokens(usage.unpricedTokens)} tok 旧站模型未计价` : ''
    ].filter(Boolean).join('；')
  }
}

const VIEW = {
  v: 2,
  type: 'stack',
  title: '用量与费用',
  children: [
    {
      type: 'stack',
      label: '官方 DeepSeek',
      children: [{ type: 'keyValue', items: { $: 'data.officialItems' } }]
    },
    {
      type: 'stack',
      label: 'MIKU 中转',
      children: [{ type: 'keyValue', items: { $: 'data.relayItems' } }]
    },
    { type: 'text', text: { $: 'data.priceNote' }, tone: 'muted', style: { size: 'caption' } },
    {
      type: 'table',
      columns: ['总 tokens · 缓存命中', '输出速度'],
      rows: [[{ $: 'data.tokens' }, { $: 'data.speed' }]]
    },
    { type: 'text', text: { $: 'data.speedCaption' }, tone: 'muted', style: { size: 'caption' } },
    {
      type: 'progress',
      label: '上下文占用',
      value: { $: 'data.contextPct' },
      max: 100,
      caption: { $: 'data.contextText' },
      tone: { $: 'data.contextTone' }
    },
    {
      type: 'stack',
      label: 'MIKU 账户（按量计费）',
      children: [
        { type: 'keyValue', items: { $: 'data.accountItems' } },
        { type: 'callout', text: { $: 'data.loginLabel' }, tone: { $: 'data.loginTone' } },
        {
          type: 'collapsible',
          label: '登录 / 切换账号',
          children: [
            {
              type: 'form',
              label: '密码只用于本次登录，不保存',
              submit: 'login',
              submitLabel: '登录',
              children: [
                { type: 'textField', label: '用户名', bind: 'data.loginUser', placeholder: 'MIKU 用户名' },
                { type: 'textField', label: '密码', bind: 'data.loginPass', placeholder: '登录密码' }
              ]
            }
          ]
        }
      ]
    },
    {
      type: 'stack',
      label: '本站模型（实时）',
      children: [{ type: 'list', items: { $: 'data.modelItems' } }]
    },
    { type: 'keyValue', items: { $: 'data.breakdown' } },
    { type: 'keyValue', items: { $: 'data.tiers' } },
    {
      type: 'actions',
      items: [
        { label: '刷新账户', action: 'refreshAccount', style: 'primary' },
        { label: '复制用量', action: 'copyUsage' },
        { label: '退出登录', action: 'logout' }
      ]
    }
  ]
}

function summaryText(usage, acc) {
  if (!usage || usage.tokens === 0) return '当前会话还没有用量。'
  return [
    '用量与费用（本会话估算）',
    `费用：${fmtMoney(usage.cost)} CNY`,
    `tokens：${fmtExact(usage.tokens)}（输入 ${fmtExact(usage.uncachedInput)} / 缓存 ${fmtExact(usage.cacheRead)} / 输出 ${fmtExact(usage.output)}）`,
    `缓存命中：${fmtPct(usage.cacheHit)}`,
    `计费请求：${usage.requests} 次`,
    `官方 · 本轮/会话：${fmtMoney(usage.turnOfficialCost)} / ${fmtMoney(usage.officialCost)}`,
    `中转 · 本轮/会话：${fmtMoney(usage.turnRelayCost)} / ${fmtMoney(usage.relayCost)}`,
    `MIKU 余额：${acc?.balance ?? '—'}`,
    '估算值，以官方账单为准。'
  ].join('\n')
}

export function apply(ctx) {
  // 每轮结束后刷新一次账户读数（成功后 5 分钟内不重复请求）
  try {
    ctx.on('session/event', (_session, event) => {
      if (event?.type === 'turn/end') void account.refresh().catch(() => {})
    })
  } catch {
    // ctx.on 不可用：读数靠面板/小窗打开时 refresh
  }

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.strip('strip', (scope, emit, caps) => {
      let stopped = false
      const render = () => {
        if (stopped) return
        const usage = computeUsage(ctx, scope.sessionId)
        const rate = computeRate(ctx, scope.sessionId)
        const acc = account.get()
        const effect = { text: stripText(usage, rate, acc), icon: 'coin' }
        if (acc?.balanceTone === 'bad') effect.tone = 'bad'
        else if (acc?.balanceTone === 'warn') effect.tone = 'warn'
        emit(effect)
      }
      const tick = () => {
        render()
        void account.refresh().then(render)
        void refreshOfficial(ctx, caps).then(render)
      }
      tick()
      const timer = setInterval(tick, TICK_MS)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    })

    ctx.dshGo.panel('hud', {
      view: () => VIEW,
      data: (scope, emit, caps) => {
        let stopped = false
        const push = () => {
          if (stopped) return
          emit(panelData(
            computeUsage(ctx, scope.sessionId),
            computeRate(ctx, scope.sessionId),
            account.get(),
            modelsCache.rows
          ))
        }
        const tick = () => {
          push()
          void account.refresh().then(push)
          void liveModels().then(push)
          void refreshOfficial(ctx, caps).then(push)
        }
        tick()
        const timer = setInterval(tick, TICK_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      },
      actions: {
        // 面板内登录：兼容各版本表单提交的载荷形状
        login: (_scope, event) => {
          const strings = []
          const named = {}
          const walk = (v) => {
            if (typeof v === 'string') { strings.push(v); return }
            if (Array.isArray(v)) { for (const x of v) walk(x); return }
            if (!v || typeof v !== 'object') return
            if (typeof v.bind === 'string' && typeof v.value === 'string') {
              named[String(v.bind).split('.').pop()] = v.value
            }
            for (const [k, x] of Object.entries(v)) {
              if (typeof x === 'string') {
                named[k] = x
                if (k.startsWith('data.')) named[k.split('.').pop()] = x
                walk(x)
              } else walk(x)
            }
          }
          walk(event?.value ?? {})
          const pick = (names) => {
            for (const n of names) if (typeof named[n] === 'string' && named[n] !== '') return named[n]
            return ''
          }
          let username = pick(['loginUser', 'username', 'user', 'u']).trim()
          let password = pick(['loginPass', 'password', 'pass', 'p'])
          if (!username || !password) {
            const filled = strings.filter((x) => x !== '' && !x.startsWith('data.') && !x.includes('.'))
            if (!username && filled.length >= 1) username = filled[0].trim()
            if (!password && filled.length >= 2) password = filled[1]
          }
          if (!username || !password) {
            const nothing = Object.keys(named).length === 0 && strings.length === 0
            return { toast: nothing ? '没读到输入框内容，请重开面板' : '请先填写用户名和密码' }
          }
          return {
            pending: { label: '正在登录 MIKU', timeoutMs: 30000 },
            result: async () => {
              try {
                const token = await miku.login(username, password)
                await saveToken(token)
                account.forget()
                const acc = await account.refresh(true)
                return { toast: `已登录 ${acc?.username ?? username}，余额 ${acc?.balance ?? '—'}`, refresh: true }
              } catch (error) {
                return { toast: `登录失败：${String(error?.message || error).slice(0, 26)}` }
              }
            }
          }
        },
        copyUsage: (scope) => {
          const usage = computeUsage(ctx, scope.sessionId)
          if (usage.tokens === 0) return { toast: '当前会话还没有用量' }
          return { copy: summaryText(usage, account.get()), toast: '已复制' }
        },
        refreshAccount: () => ({
          pending: { label: '正在查询账户', timeoutMs: 30000 },
          result: async () => {
            try {
              const acc = await account.refresh(true)
              if (!acc) return { toast: '还没登录，请展开「登录 / 切换账号」' }
              return { toast: `余额 ${acc.balance}` }
            } catch (error) {
              return { toast: `查询失败：${String(error?.message || error).slice(0, 26)}` }
            }
          }
        }),
        logout: () => ({
          pending: { label: '正在退出', timeoutMs: 15000 },
          result: async () => {
            await clearToken()
            account.forget()
            return { toast: '已退出登录' }
          }
        })
      }
    })
  })
}
