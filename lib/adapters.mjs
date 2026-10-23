// 供应商额度适配器：内置白名单适配器 + sub2api 中继自动识别。
// 安全约束：凭据只在 Host 内存；内置适配器只请求写死域名；sub2api 只请求 profile 里
// 用户自己配置的 baseURL；所有对外的错误信息统一脱敏（safeMsg）。
import { profileProviders } from './profile.mjs'

// ---------------------------------------------------------------- 工具

export function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/** 错误信息脱敏：打码常见凭据形态并截断。 */
export function safeMsg(e) {
  return String((e && e.message) || e)
    .replace(/(sk-|Bearer\s+|xox[abprs]-|gh[pousr]_)[A-Za-z0-9._-]+/gi, '$1***')
    .slice(0, 200)
}

export function clampPct(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
}

export function num(v) {
  if (v == null || (typeof v === 'string' && !v.trim()) || (typeof v !== 'number' && typeof v !== 'string')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 URL 的 host（小写），非法 URL 返回 null。 */
export function urlHost(u) {
  try { return new URL(String(u || '')).host.toLowerCase() } catch { return null }
}

/** 全程受超时约束的 JSON GET（响应头与 body 解析都在同一个中止时限内）。 */
export async function fetchJson(url, init, ms = 10000) {
  const once = async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(err('model-usage/timeout', '请求超时')), ms)
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal, redirect: 'follow' })
      let data = null
      try { data = await res.json() } catch { /* 非 JSON 响应 */ }
      return { status: res.status, ok: res.ok, data }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    return await once()
  } catch (e) {
    if (e && e.code === 'model-usage/timeout') throw e
    await sleep(400)
    return await once() // 网络层失败重试一次
  }
}

/** 业务层错误提炼（部分接口 key 错误也返回 HTTP 200）。 */
export function bizError(d) {
  if (!d || typeof d !== 'object') return ''
  if (d.success === false || d.ok === false) return safeMsg(String(d.msg || d.message || d.error || 'success=false'))
  const c = Number(d.code)
  if (Number.isFinite(c) && c !== 0 && c !== 200 && d.msg) return safeMsg(String(d.msg))
  if (typeof d.error === 'string' && d.error) return safeMsg(d.error)
  return ''
}

/** 按顺序解析凭据 ref：凭据服务优先，环境变量兜底。 */
export async function resolveKey(env) {
  const cred = env.credentials
  for (const ref of env.refs || []) {
    if (!ref) continue
    if (cred && typeof cred.resolve === 'function') {
      try {
        const hit = await cred.resolve(ref)
        if (hit && hit.value) return hit.value
      } catch { /* 继续尝试下一个 ref */ }
    }
    if (process.env[ref]) return process.env[ref]
  }
  return null
}

const noKey = (env) => ({ status: 'needs-credential', credential: { refs: env.refs, configured: false } })
const unsupported = (code, message) => ({ status: 'unsupported', error: { code, message } })
const badAuth = (res, what) => {
  if (res.status === 401 || res.status === 403) throw err('model-usage/unauthorized', 'HTTP ' + res.status + '（' + what + '无效或过期）')
  if (!res.ok) throw err('model-usage/http', 'HTTP ' + res.status)
}

// ---------------------------------------------------------------- 内置适配器

const deepseekBalance = {
  id: 'deepseek-balance',
  refs: () => ['DEEPSEEK_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const custom = process.env.DEEPSEEK_BASE_URL
    if (custom) {
      try {
        if (new URL(custom).host !== 'api.deepseek.com') return unsupported('model-usage/custom-endpoint', '自定义网关没有余额接口')
      } catch { /* 忽略非法 URL */ }
    }
    const res = await fetchJson('https://api.deepseek.com/user/balance', { headers: { authorization: 'Bearer ' + key } })
    badAuth(res, 'API key')
    const biz = bizError(res.data)
    if (biz) return { status: 'error', error: { code: 'model-usage/biz', message: biz } }
    const infos = Array.isArray(res.data && res.data.balance_infos) ? res.data.balance_infos : []
    const pick = infos.find((i) => i && i.currency === 'CNY') || infos[0]
    if (!pick) return unsupported('model-usage/empty', '余额响应缺少 balance_infos 字段')
    return {
      status: 'ok', kind: 'balance',
      balance: {
        currency: String(pick.currency || 'CNY').toUpperCase(),
        total: String(pick.total_balance ?? ''),
        granted: String(pick.granted_balance ?? '0'),
        toppedUp: String(pick.topped_up_balance ?? '0'),
        available: res.data.is_available !== false,
      },
    }
  },
}

const deepseekAccount = {
  id: 'deepseek-account',
  refs: () => [],
  async read(env) {
    const acct = env.getAccount ? env.getAccount() : null
    if (!acct || typeof acct.getBalance !== 'function') return unsupported('model-usage/no-service', '当前 DSH 没有账号余额服务')
    const meta = {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || 'unknown'),
      locale: 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    const res = await Promise.race([
      acct.getBalance(meta).catch(() => null),
      new Promise((r) => setTimeout(() => r('timeout'), 15000)),
    ])
    if (res === 'timeout') throw err('model-usage/timeout', '账号余额请求超时')
    if (!res) return { status: 'needs-signin' }
    if (res.status !== 'ready') return { status: 'error', error: { code: 'model-usage/account', message: '账号余额接口未就绪（' + String(res.status || 'unknown') + '）' } }
    const usable = (list) => (Array.isArray(list) ? list : [])
      .map((w) => ({ cur: String((w && w.currency) || 'CNY').toUpperCase(), v: num(w && w.balance) }))
      .filter((w) => w.v !== null)
    const recharge = usable(res.value)
    const bonus = usable(res.bonusWallets)
    const all = recharge.concat(bonus)
    if (!all.length) return unsupported('model-usage/empty', '账号没有可用的余额钱包')
    const nonzero = all.filter((w) => w.v > 0)
    const cur = (nonzero.find((w) => w.cur === 'CNY') || nonzero[0] || all.find((w) => w.cur === 'CNY') || all[0]).cur
    const sum = (l) => l.filter((w) => w.cur === cur).reduce((s, w) => s + w.v, 0)
    return {
      status: 'ok', kind: 'wallet',
      balance: { currency: cur, total: (sum(recharge) + sum(bonus)).toFixed(2), granted: sum(bonus).toFixed(2), toppedUp: sum(recharge).toFixed(2), available: true },
    }
  },
}

/** GLM data.limits[] 按 type+unit 选窗口条目（数组顺序不保证）。 */
function pickWindow(limits, unit) {
  if (!Array.isArray(limits)) return null
  for (const it of limits) {
    if (!it || typeof it !== 'object') continue
    const type = String(it.type || '')
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue
    if (Number(it.unit) === unit) return it
  }
  return null
}

/** 重置时间解析：兼容 ISO 字符串、秒级/毫秒级时间戳；非法值返回 null。 */
function parseReset(v) {
  if (v == null || v === '') return null
  if (typeof v === 'string') {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) return p
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n // 秒级时间戳兜底转毫秒
}

/** 次月 1 日 00:00 UTC（GLM MCP 月度限额重置口径：接口不返回 nextResetTime，按文档为每月 1 日重置）。 */
function nextMonthUtc() {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

const glmCoding = {
  id: 'glm-coding',
  refs: (cfg, route) => [route === 'zai' ? 'ZAI_API_KEY' : 'ZAI_CODING_CN_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const pHost = urlHost(env.providerBaseURL)
    const host = pHost === 'api.z.ai' || pHost === 'open.bigmodel.cn'
      ? 'https://' + pHost
      : env.route === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
    const g = (env.config && env.config.glm) || {}
    const url = host + '/api/monitor/usage/quota/limit' + (g.planType ? '?type=' + encodeURIComponent(String(g.planType)) : '')
    const headers = { authorization: key, accept: 'application/json' }
    if (g.organization) headers['bigmodel-organization'] = String(g.organization)
    if (g.project) headers['bigmodel-project'] = String(g.project)
    let res = await fetchJson(url, { headers })
    if (res.status === 401) res = await fetchJson(url, { headers: { ...headers, authorization: 'Bearer ' + key } })
    badAuth(res, 'key')
    const biz = bizError(res.data)
    if (biz) {
      const noPlan = /coding plan/i.test(biz)
      return { status: noPlan ? 'unsupported' : 'error', error: { code: 'model-usage/biz', message: noPlan ? biz + '（该 key 可能不是 Coding Plan 订阅账号）' : biz } }
    }
    const d = res.data && res.data.data
    const limits = d && Array.isArray(d.limits) ? d.limits : null
    if (!limits) return unsupported('model-usage/shape', '响应缺少 data.limits 字段（接口可能改版）')
    const windows = []
    for (const [k, label, unit] of [['rolling', '5h', 3], ['weekly', '周', 6]]) {
      const it = pickWindow(limits, unit)
      if (it) windows.push({ key: k, label, usedPct: clampPct(it.percentage), resetAt: parseReset(it.nextResetTime) })
    }
    // 每月 MCP/工具调用次数限额：type=TIME_LIMIT, unit=5
    const timeLimit = limits.find((it) => it && String(it.type) === 'TIME_LIMIT' && Number(it.unit) === 5)
    if (timeLimit) {
      const limit = num(timeLimit.usage)
      const remaining = num(timeLimit.remaining)
      const pctRaw = num(timeLimit.percentage)
      windows.push({
        key: 'mcp', label: 'MCP/月',
        usedPct: clampPct(pctRaw != null ? pctRaw : (limit > 0 && remaining != null ? (1 - remaining / limit) * 100 : 0)),
        resetAt: parseReset(timeLimit.nextResetTime) || nextMonthUtc(),
        countBased: true, limit, remaining,
      })
    }
    if (!windows.length) return unsupported('model-usage/shape', 'data.limits 中未找到 5h/周窗口条目')
    return { status: 'ok', kind: 'quota', plan: typeof d.level === 'string' ? d.level : '', windows }
  },
}

// Kimi Coding Plan：usage(周窗口) + limits[](滚动窗口，300 分钟 = 5h)
const kimiCoding = {
  id: 'kimi-coding',
  refs: () => ['KIMI_CODING_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const res = await fetchJson('https://api.kimi.com/coding/v1/usages', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    badAuth(res, 'Kimi 凭据')
    const data = res.data || {}
    const windows = []
    const weekly = data.usage
    if (weekly) {
      const limit = num(weekly.limit)
      const used = num(weekly.used)
      if (limit > 0 && used != null) windows.push({ key: 'weekly', label: '周', usedPct: clampPct((used / limit) * 100), resetAt: weekly.resetTime ? Date.parse(weekly.resetTime) || null : null })
    }
    for (const entry of Array.isArray(data.limits) ? data.limits : []) {
      const detail = (entry && entry.detail) || {}
      const limit = num(detail.limit)
      const remaining = num(detail.remaining)
      const used = num(detail.used) ?? (limit != null && remaining != null ? limit - remaining : null)
      if (!limit || limit <= 0 || used == null) continue
      const w = (entry && entry.window) || {}
      const dur = num(w.duration) || 0
      const unit = String(w.timeUnit || '')
      let label = '滚动窗口'
      if (unit === 'TIME_UNIT_MINUTE' && dur > 0) label = dur % 60 === 0 ? dur / 60 + 'h' : dur + 'm'
      else if (unit === 'TIME_UNIT_HOUR' && dur > 0) label = dur + 'h'
      else if (unit === 'TIME_UNIT_DAY' && dur > 0) label = dur + 'd'
      windows.push({ key: dur >= 240 && dur <= 360 ? 'rolling' : 'w' + Math.round(dur) + unit, label, usedPct: clampPct((used / limit) * 100), resetAt: detail.resetTime ? Date.parse(detail.resetTime) || null : null })
    }
    if (!windows.length) return unsupported('model-usage/shape', 'Kimi 响应中未找到额度窗口')
    const level = data && data.user && data.user.membership && data.user.membership.level
    return { status: 'ok', kind: 'quota', plan: level ? String(level).replace(/^LEVEL_/, '').toLowerCase() : '', windows }
  },
}

// Moonshot / Kimi 平台余额
const moonshotBalance = {
  id: 'moonshot-balance',
  refs: (cfg, route) => [/cn$/.test(route) ? 'MOONSHOT_CN_API_KEY' : 'MOONSHOT_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_CN_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const pHost = urlHost(env.providerBaseURL)
    const cn = pHost ? pHost === 'api.moonshot.cn' : /cn$/.test(env.route || '')
    const res = await fetchJson((cn ? 'https://api.moonshot.cn' : 'https://api.moonshot.ai') + '/v1/users/me/balance', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    badAuth(res, 'Moonshot Key')
    const d = (res.data && res.data.data) || res.data || {}
    const available = num(d.available_balance)
    if (available == null) return unsupported('model-usage/shape', 'Moonshot 未返回 available_balance')
    const cash = num(d.cash_balance)
    const voucher = num(d.voucher_balance)
    return {
      status: 'ok', kind: 'balance',
      balance: { currency: cn ? 'CNY' : 'USD', total: available.toFixed(2), toppedUp: cash != null ? cash.toFixed(2) : '', granted: voucher != null ? voucher.toFixed(2) : '', available: available > 0 },
    }
  },
}

// OpenRouter：/api/v1/credits，兜底 /api/v1/key
const openrouter = {
  id: 'openrouter',
  refs: () => ['OPENROUTER_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const headers = { authorization: 'Bearer ' + key, accept: 'application/json' }
    const res = await fetchJson('https://openrouter.ai/api/v1/credits', { headers })
    badAuth(res, 'OpenRouter 凭据')
    if (res.ok) {
      const d = (res.data && res.data.data) || {}
      const total = num(d.total_credits)
      const used = num(d.total_usage)
      if (total != null && used != null) {
        const remain = Math.max(0, total - used)
        return { status: 'ok', kind: 'balance', balance: { currency: 'USD', total: remain.toFixed(2), toppedUp: total.toFixed(2), granted: '0.00', available: remain > 0 } }
      }
    }
    const res2 = await fetchJson('https://openrouter.ai/api/v1/key', { headers })
    if (!res2.ok) throw err('model-usage/http', 'HTTP ' + res2.status)
    const d2 = (res2.data && res2.data.data) || {}
    const remain2 = num(d2.limit_remaining)
    const limit = num(d2.limit)
    const usage = num(d2.usage)
    if (remain2 == null && (limit == null || usage == null)) return unsupported('model-usage/shape', 'OpenRouter 未返回额度字段')
    const total = remain2 != null ? remain2 : Math.max(0, limit - usage)
    return { status: 'ok', kind: 'balance', balance: { currency: 'USD', total: total.toFixed(2), toppedUp: limit != null ? limit.toFixed(2) : '', granted: '0.00', available: total > 0 } }
  },
}

// MiniMax Token Plan（订阅 Key）
const minimaxPlan = {
  id: 'minimax-plan',
  refs: (cfg, route) => [/cn$/.test(route) ? 'MINIMAX_CN_API_KEY' : 'MINIMAX_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const pHost = urlHost(env.providerBaseURL)
    const cn = pHost ? pHost === 'api.minimaxi.com' : /cn$/.test(env.route || '')
    const res = await fetchJson((cn ? 'https://api.minimaxi.com' : 'https://api.minimax.io') + '/v1/token_plan/remains', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    badAuth(res, 'MiniMax 订阅 Key')
    const body = res.data || {}
    const base = body.base_resp || {}
    if (Number(base.status_code) && Number(base.status_code) !== 0) return unsupported('model-usage/biz', safeMsg(String(base.status_msg || base.status_code)))
    const rows = [body.model_remains, body.models, body.data, body.data && body.data.model_remains].find((x) => Array.isArray(x) && x.length)
    if (!rows) return unsupported('model-usage/shape', 'MiniMax 未返回 model_remains')
    const pick = (row, keys) => { for (const k of keys) { const v = num(row[k]); if (v != null) return v } return null }
    let picked = null
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const intervalPct = pick(row, ['current_interval_remaining_percent', 'interval_remaining_percent', 'current_interval_remain_percent'])
      const weeklyPct = pick(row, ['current_weekly_remaining_percent', 'weekly_remaining_percent', 'current_weekly_remain_percent'])
      if (intervalPct == null && weeklyPct == null) continue
      picked = { row, intervalPct, weeklyPct }
      break
    }
    if (!picked) return unsupported('model-usage/shape', 'MiniMax 配额字段缺失')
    const now = Date.now()
    const endAt = (row, keys) => { const v = pick(row, keys); return v == null ? null : (v < 1e12 ? v * 1000 : v) }
    const remainsToReset = (row, keys) => { const ms = pick(row, keys); return ms == null ? null : now + ms }
    const windows = []
    if (picked.intervalPct != null) windows.push({ key: 'rolling', label: '5h', usedPct: clampPct(100 - picked.intervalPct), resetAt: endAt(picked.row, ['end_time', 'current_interval_end_time', 'interval_end_time']) || remainsToReset(picked.row, ['remains_time', 'current_interval_remains_time', 'interval_remains_time']) })
    if (picked.weeklyPct != null) windows.push({ key: 'weekly', label: '周', usedPct: clampPct(100 - picked.weeklyPct), resetAt: endAt(picked.row, ['weekly_end_time', 'current_weekly_end_time']) || remainsToReset(picked.row, ['weekly_remains_time', 'current_weekly_remains_time']) })
    const plan = typeof (picked.row.subscribe_title || picked.row.plan_name || body.plan_name) === 'string' ? String(picked.row.subscribe_title || picked.row.plan_name || body.plan_name) : ''
    return { status: 'ok', kind: 'quota', plan, windows }
  },
}

// OpenCode Go（订阅）
const opencodeGo = {
  id: 'opencode-go',
  refs: () => ['OPENCODE_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const res = await fetchJson('https://opencode.ai/zen/go/v1/usage', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    badAuth(res, 'OpenCode Key')
    const u = (res.data && res.data.usage) || {}
    const windows = []
    for (const [key2, label] of [['rolling', '5h'], ['weekly', '周'], ['monthly', '月']]) {
      const it = u[key2]
      if (!it || typeof it !== 'object') continue
      const pct = num(it.percent)
      if (pct == null) continue
      const resetRaw = it.resetsAt
      windows.push({ key: key2, label, usedPct: clampPct(pct), resetAt: typeof resetRaw === 'string' ? Date.parse(resetRaw) || null : num(resetRaw) })
    }
    if (!windows.length) return unsupported('model-usage/shape', 'OpenCode Go 未返回 usage 窗口')
    return { status: 'ok', kind: 'quota', windows }
  },
}

// 小米 MiMo 余额
const xiaomiBalance = {
  id: 'xiaomi-balance',
  refs: () => ['XIAOMI_API_KEY'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const res = await fetchJson('https://platform.xiaomimimo.com/api/v1/balance', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    badAuth(res, 'Xiaomi Key')
    const d = (res.data && (res.data.data || res.data.result)) || res.data || {}
    const val = [d.balance, d.remaining, d.available_balance, d.total_balance].map(num).find((v) => v != null)
    if (val == null) return unsupported('model-usage/shape', 'Xiaomi 未返回余额字段')
    return { status: 'ok', kind: 'balance', balance: { currency: 'CNY', total: val.toFixed(2), toppedUp: '', granted: '', available: val > 0 } }
  },
}

// GitHub Copilot 配额
const githubCopilot = {
  id: 'github-copilot',
  refs: () => ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_COPILOT_TOKEN'],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const res = await fetchJson('https://api.github.com/copilot_internal/user', { headers: { authorization: 'Bearer ' + key, accept: 'application/json', 'user-agent': 'dsh-model-usage' } })
    badAuth(res, 'GitHub Copilot token')
    const body = res.data || {}
    const snap = body.quota_snapshots
    if (!snap || typeof snap !== 'object') return unsupported('model-usage/shape', 'Copilot 未返回 quota_snapshots（非 Copilot 账号或接口改版）')
    let resetAt = null
    const qr = num(body.quota_reset_date)
    if (qr != null) resetAt = qr < 1e12 ? qr * 1000 : qr
    const windows = []
    for (const [key2, label] of [['premium_interactions', 'Premium'], ['chat', 'Chat'], ['completions', '补全']]) {
      const it = snap[key2]
      if (!it || typeof it !== 'object') continue
      const pctRemain = num(it.percent_remaining)
      const remain = num(it.remaining)
      const ent = num(it.entitlement)
      let usedPct = null
      if (pctRemain != null) usedPct = clampPct(100 - pctRemain)
      else if (remain != null && ent != null && ent > 0) usedPct = clampPct(((ent - remain) / ent) * 100)
      if (usedPct == null) continue
      windows.push({ key: key2, label, usedPct, resetAt, countBased: remain != null && ent != null, remaining: remain, limit: ent })
    }
    if (!windows.length) return unsupported('model-usage/shape', 'Copilot 配额为空')
    return { status: 'ok', kind: 'quota', plan: typeof body.copilot_plan === 'string' ? body.copilot_plan : '', windows }
  },
}

// ---------------------------------------------------------------- sub2api 中继

/**
 * sub2api 中继适配器：GET {baseURL}/v1/usage（Bearer）。
 * 响应识别：mode ∈ quota_limited | unrestricted 且带 isValid。
 * 解析口径与官方 CC Switch 脚本一致：remaining ?? quota.remaining ?? balance。
 */
export const sub2api = {
  id: 'sub2api',
  refs: () => [],
  async read(env) {
    const key = await resolveKey(env)
    if (!key) return noKey(env)
    const base = String(env.baseURL || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
    if (!base) return unsupported('model-usage/config', '缺少 baseURL')
    const res = await fetchJson(base + '/v1/usage', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
    if (res.status === 401 || res.status === 403) {
      const code = res.data && res.data.code
      if (code === 'INVALID_API_KEY') throw err('model-usage/unauthorized', 'HTTP 401（API key 无效或过期）')
      throw err('model-usage/unauthorized', 'HTTP ' + res.status)
    }
    if (!res.ok) throw err('model-usage/http', 'HTTP ' + res.status)
    const d = res.data
    const isSub2api = d && typeof d === 'object' && (d.mode === 'quota_limited' || d.mode === 'unrestricted') && 'isValid' in d
    if (!isSub2api) throw err('model-usage/not-sub2api', '响应不符合 sub2api 协议')
    const out = { status: 'ok', valid: d.isValid !== false, fetchedAt: Date.now() }
    const winOf = (key2, label, ent) => {
      const limit = num(ent && ent.limit)
      const used = num(ent && ent.used)
      if (!limit || limit <= 0 || used == null) return null
      const resetRaw = ent.reset_at
      return { key: key2, label, usedPct: clampPct((used / limit) * 100), used, limit, remaining: Math.max(0, limit - used), countBased: true, resetAt: resetRaw ? Date.parse(resetRaw) || null : null }
    }
    if (d.mode === 'quota_limited') {
      if (d.quota && typeof d.quota === 'object') {
        const limit = num(d.quota.limit)
        const used = num(d.quota.used)
        const remaining = num(d.quota.remaining)
        if (remaining != null) out.quota = { limit, used, remaining, unit: String(d.quota.unit || d.unit || 'USD') }
      } else {
        const remaining = num(d.remaining)
        if (remaining != null) out.quota = { limit: null, used: null, remaining, unit: String(d.unit || 'USD') }
      }
      const windows = []
      for (const ent of Array.isArray(d.rate_limits) ? d.rate_limits : []) {
        const w = winOf(ent.window === '5h' ? 'rolling' : ent.window === '1d' ? 'daily' : ent.window === '7d' ? 'weekly' : String(ent.window || 'w'), String(ent.window || ''), ent)
        if (w) windows.push(w)
      }
      if (windows.length) out.windows = windows
      const exp = d.expires_at ? Date.parse(d.expires_at) : null
      if (exp) { out.expiresAt = exp; out.daysUntilExpiry = num(d.days_until_expiry) }
      out.kind = out.quota || out.windows ? 'quota' : 'balance'
    } else {
      // 注意：不采用 sub2api 的 planName——它是站主自定义的分组文案，多为营销内容
      const sub = d.subscription && typeof d.subscription === 'object' ? d.subscription : null
      if (sub) {
        const windows = []
        for (const [key2, label, uk, lk] of [['daily', '日', 'daily_usage_usd', 'daily_limit_usd'], ['weekly', '周', 'weekly_usage_usd', 'weekly_limit_usd'], ['monthly', '月', 'monthly_usage_usd', 'monthly_limit_usd']]) {
          const limit = num(sub[lk])
          const used = num(sub[uk])
          if (!limit || limit <= 0 || used == null) continue
          windows.push({ key: key2, label, usedPct: clampPct((used / limit) * 100), used, limit, remaining: Math.max(0, limit - used), resetAt: key2 === 'weekly' && sub.weekly_window_start ? Date.parse(sub.weekly_window_start) + 7 * 86400000 : null })
        }
        if (windows.length) out.windows = windows
        const remaining = num(d.remaining)
        if (remaining != null && remaining >= 0) out.quota = { limit: null, used: null, remaining, unit: String(d.unit || 'USD') }
        out.kind = 'quota'
      } else {
        const balance = num(d.balance ?? d.remaining)
        if (balance == null) return unsupported('model-usage/shape', 'sub2api 响应缺少 remaining/balance 字段')
        out.kind = 'balance'
        out.balance = { currency: String(d.unit || 'USD'), total: balance.toFixed(2), toppedUp: '', granted: '', available: d.isValid !== false && balance > 0 }
      }
      const exp = d.expires_at ? Date.parse(d.expires_at) : null
      if (exp) { out.expiresAt = exp; out.daysUntilExpiry = num(d.days_until_expiry) }
    }
    return out
  },
}

// ---------------------------------------------------------------- 分发

const BUILTIN = {
  'deepseek-balance': deepseekBalance,
  'deepseek-account': deepseekAccount,
  'glm-coding': glmCoding,
  'kimi-coding': kimiCoding,
  'moonshot-balance': moonshotBalance,
  'openrouter': openrouter,
  'minimax-plan': minimaxPlan,
  'opencode-go': opencodeGo,
  'xiaomi-balance': xiaomiBalance,
  'github-copilot': githubCopilot,
  'sub2api': sub2api,
}

/**
 * 按供应商 baseURL 识别内置查询模板（host 精确匹配，防近似域名冒充）。
 * 用量接口地址与响应结构由插件内置，profile 里的 provider 只需提供 baseURL + apiKeyEnv。
 */
const URL_RULES = [
  { host: 'api.kimi.com', path: /^\/coding(\/|$)/i, adapter: kimiCoding },
  { host: 'openrouter.ai', adapter: openrouter },
  { host: 'api.moonshot.cn', adapter: moonshotBalance },
  { host: 'api.moonshot.ai', adapter: moonshotBalance },
  { host: 'api.z.ai', adapter: glmCoding },
  { host: 'open.bigmodel.cn', adapter: glmCoding },
  { host: 'api.deepseek.com', adapter: deepseekBalance },
  { host: 'api.minimax.io', adapter: minimaxPlan },
  { host: 'api.minimaxi.com', adapter: minimaxPlan },
  { host: 'opencode.ai', adapter: opencodeGo },
  { host: 'platform.xiaomimimo.com', adapter: xiaomiBalance },
]

function adapterForURL(baseURL) {
  if (!baseURL) return null
  let u
  try { u = new URL(String(baseURL)) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.host.toLowerCase()
  for (const rule of URL_RULES) {
    if (rule.host !== host) continue
    if (rule.path && !rule.path.test(u.pathname)) continue
    return rule.adapter
  }
  return null
}

/**
 * 同步分发：显式绑定 > profile baseURL 识别 > DSH 内置路由名匹配。
 * provider 传 profile 中该路由的 { baseURL, apiKeyEnv }（可空）。
 *
 * 路由名表只覆盖 DSH 内置 provider 的已知 id（kimi-coding、moonshotai 等）；
 * 自定义 provider 必然带 baseURL（URL 识别），识别不出就返回 null 交 sub2api
 * 探测或隐藏——绝不按名字猜测，避免把 key 发往错误的官方域名。
 * 注意：kimi 不再是 moonshot 的别名（DSH 内置列表只有 kimi-coding 与 moonshotai，
 * 不存在单独的 kimi 路由；自定义 kimi* 路由靠 profile 的 baseURL 识别）。
 */
export function adapterFor(route, cfg, provider) {
  if (!route) return null
  const selected = cfg && cfg.adapters && cfg.adapters[route]
  if (selected) return Object.hasOwn(BUILTIN, selected) ? BUILTIN[selected] : null
  const baseURL = provider && provider.baseURL
  if (baseURL) return adapterForURL(baseURL)
  if (route === 'deepseek-official' || route === 'deepseek') return deepseekBalance
  if (route === 'deepseek-account') return deepseekAccount
  if (route === 'zai-coding-cn' || route === 'zai') return glmCoding
  if (/^openrouter/i.test(route)) return openrouter
  if (/^kimi-coding/i.test(route)) return kimiCoding
  if (/^moonshot/i.test(route)) return moonshotBalance
  if (/^minimax/i.test(route)) return minimaxPlan
  if (/^opencode-go/i.test(route)) return opencodeGo
  if (/^(xiaomi|mimo)/i.test(route)) return xiaomiBalance
  if (/^github-copilot/i.test(route)) return githubCopilot
  return null
}

/**
 * 为未命中内置适配器的路由解析 sub2api 端点。
 * 返回 { adapter, baseURL, apiKeyEnv } 或 null。结果由调用方缓存。
 */
export async function resolveSub2api(route, cfg) {
  const explicit = cfg && cfg.sub2api && cfg.sub2api[route]
  if (explicit && explicit.baseURL) return { adapter: sub2api, baseURL: String(explicit.baseURL), apiKeyEnv: explicit.keyRef || null }
  const providers = await profileProviders([route])
  const p = providers[route]
  if (!p || !p.baseURL) return null
  return { adapter: sub2api, baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv || null }
}
