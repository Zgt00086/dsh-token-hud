// MIKU 中转站（按量计费，非积分）：用户名密码登录一次换 session token，
// 之后只用 token 查询；密码从不落盘，token 用 AES-256-GCM 加密保存。
// 主站不可达时自动切备用站。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BASES = ['http://mikumc.com:8888', 'http://47.100.106.67:8888']
const TIMEOUT_MS = 8_000
const OK_MS = 5 * 60_000
const FAIL_MS = 60_000

const HOME = () => process.env.TOKEN_HUD_HOME || process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
const TOKEN_PATH = () => join(HOME(), 'dsh-go/private/token-hud/miku-token.bin')
const SALT_PATH = () => join(HOME(), 'dsh-go/private/token-hud/salt')

/** 微元（1e6 = ¥1）转成两位小数显示。 */
export function yuan(micro) {
  const n = Number(micro)
  if (!Number.isFinite(n)) return '—'
  return '¥' + (n / 1e6).toFixed(2)
}

/** /api/me 的响应归一化；字段缺失时留 null，绝不编造 0。 */
export function normalizeMe(payload) {
  const u = payload?.data ?? payload ?? {}
  const st = u.stats ?? {}
  const balanceMicro = Number(u.balanceMicro)
  return {
    username: typeof u.username === 'string' ? u.username : '',
    balanceMicro: Number.isFinite(balanceMicro) ? balanceMicro : null,
    balance: yuan(balanceMicro),
    balanceTone: !Number.isFinite(balanceMicro) ? undefined : balanceMicro <= 0 ? 'bad' : balanceMicro < 5e6 ? 'warn' : 'good',
    totalTokens: num(st.totalTokens),
    todayRequests: num(st.todayRequests),
    todayTokens: num(st.todayTokens),
    todayInput: num(st.todayInput),
    todayOutput: num(st.todayOutput),
    todayCached: num(st.todayCached),
    todayCost: cost(st.todayCost),
    totalRequests: num(st.totalRequests),
    totalCost: cost(st.totalCost),
    checkedAt: Date.now(),
  }
}

/** /api/models 归一化：只保留本站此刻真实提供的模型，不预设任何名单。 */
export function normalizeModels(payload) {
  const list = payload?.data?.models ?? payload?.models ?? payload?.data ?? []
  if (!Array.isArray(list)) return []
  return list
    .filter((m) => m && (typeof m.id === 'string' || typeof m.displayName === 'string'))
    .map((m) => {
      const p = m.ourPricing?.offPeak ?? m.ourPricing?.peak ?? {}
      const price = (v) => (Number.isFinite(Number(v)) ? '¥' + Number(v) : '—')
      const multiplier = Number(m.multiplier)
      const peak = m.ourPricing?.peak ?? {}
      const rate = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
      return {
        name: m.displayName || m.id,
        id: m.id || m.displayName,
        multiplier: Number.isFinite(multiplier) ? (multiplier === 0 ? '免费' : multiplier + ' 倍') : '—',
        free: Number.isFinite(multiplier) && multiplier === 0,
        input: price(p.inputMiss),
        output: price(p.output),
        // 站内实价（CNY / 百万 tokens），用于按站点费率估算
        pricing: {
          offPeak: { inputMiss: rate(p.inputMiss), inputHit: rate(p.inputHit), output: rate(p.output) },
          peak: { inputMiss: rate(peak.inputMiss), inputHit: rate(peak.inputHit), output: rate(peak.output) },
        },
      }
    })
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const cost = (v) => (Number.isFinite(Number(v)) ? '¥' + Number(v).toFixed(2) : null)
const show = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'))

export { show as showNum }

/** 一次请求：主站失败自动切备用站；服务端明确拒绝（密码错/未登录）不换站重试。 */
async function request(path, { token, method = 'GET', body, request: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  let lastError = null
  for (const base of BASES) {
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = 'Bearer ' + token
      const res = await fetchImpl(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const payload = await res.json().catch(() => null)
      if (res.status === 401 || res.status === 403) {
        // 凭据问题：换站也没用，直接抛
        const msg = payload?.error?.message || '登录已失效，请重新登录'
        throw Object.assign(new Error(msg), { auth: true })
      }
      if (!res.ok) throw Object.assign(new Error(payload?.error?.message || '请求失败 ' + res.status), { fatal: true })
      return payload
    } catch (error) {
      if (error?.auth || error?.fatal) throw error
      lastError = error
    }
  }
  throw new Error('主备站都不可达：' + String(lastError?.message || lastError).slice(0, 60))
}

export class MikuClient {
  constructor(fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.fetch = fetchImpl
  }

  /** 用户名密码换 session token。密码只用于这一次请求，不保存。 */
  async login(username, password) {
    const user = String(username || '').trim()
    const pass = String(password || '')
    if (!user || !pass) throw new Error('需要用户名和密码')
    const payload = await request('/api/auth/login', {
      method: 'POST',
      body: { username: user, password: pass },
      request: this.fetch,
    })
    const token = payload?.data?.token ?? payload?.token
    if (typeof token !== 'string' || token.length < 8) throw new Error('登录失败：没有拿到 token')
    return token
  }

  /** 站点配置：峰谷时段与官方价（公开接口）。 */
  async site() {
    const payload = await request('/api/site-config', { request: this.fetch })
    const d = payload?.data ?? {}
    return {
      peakWindow: typeof d.peakWindow === 'string' ? d.peakWindow : '',
      official: d.official ?? null,
    }
  }

  /** 本站当前可用模型（公开接口，实时）。 */
  async models() {
    const payload = await request('/api/models', { request: this.fetch })
    return normalizeModels(payload)
  }

  async me(token) {
    const payload = await request('/api/me', { token, request: this.fetch })
    return normalizeMe(payload)
  }
}

/** 账户读数缓存：成功 5 分钟内不重查；失败保留上次读数、1 分钟后才重试。 */
export function loadAccount(client) {
  let good = null
  let lastTry = 0
  const get = () => good
  async function refresh(force = false) {
    if (!(await readToken())) return null
    const now = Date.now()
    if (force || now - lastTry >= (good ? OK_MS : FAIL_MS)) {
      lastTry = now
      try {
        good = await client.me(await readToken())
      } catch (error) {
        if (error?.auth) await clearToken()
      }
    }
    return good
  }
  return { get, refresh, forget: () => { good = null; lastTry = 0 } }
}

// ── token 加密存储 ───────────────────────────────────────────────────────────
let crypt

const persist = async (path, data, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data, { mode })
  await rename(tmp, path)
}

async function cryptor() {
  if (crypt) return crypt
  let salt
  try {
    salt = await readFile(SALT_PATH())
  } catch {
    salt = randomBytes(16)
    await persist(SALT_PATH(), salt)
  }
  const master = scryptSync(String(process.env.USER || 'root') + HOME(), salt, 32)
  crypt = { derive: () => scryptSync(master, 'miku-token', 32) }
  return crypt
}

export async function saveToken(token) {
  const value = String(token || '').trim()
  if (!value || value.length > 8192) throw new Error('token 无效')
  const { derive } = await cryptor()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(), iv)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  await persist(TOKEN_PATH(), Buffer.concat([iv, cipher.getAuthTag(), body]))
}

export async function readToken() {
  try {
    const blob = await readFile(TOKEN_PATH())
    if (blob.length < 29) return ''
    const { derive } = await cryptor()
    const decipher = createDecipheriv('aes-256-gcm', derive(), blob.subarray(0, 12))
    decipher.setAuthTag(blob.subarray(12, 28))
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

export async function clearToken() {
  await rm(TOKEN_PATH(), { force: true })
}

/** 从「北京时间 周一至周五 09:00-12:00、14:00-18:00」里解析出分钟区间。 */
export function parsePeakWindow(text) {
  const windows = [...String(text || '').matchAll(/(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})/g)]
    .map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])])
    .filter(([a, b]) => a < b && b <= 24 * 60)
  return windows.length ? windows : null
}
