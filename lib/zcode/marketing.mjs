// dsh-model-usage · ZCode 营销投放客户端（GLM 卡片「可领取额度」横幅数据源）
// 推送机制（与 ZCode 桌面端 marketing-touch-client.md 对齐）：
//   1) 客户端轮询 GET /api/v1/marketing/touch?seq=<N>（seq 从 0 递增，仅供服务端日志定位），
//      投放分 banner / popup 两类资源位，领取按钮 action 为 claim_zcode_plan + plan_id，
//      套餐元数据（plan_id / name / entitlements[]）随投放 args.zcode_plan 下发；
//   2) 领取 POST /api/v1/zcode-plan/billing/claim（body {plan_id}），成功后 Start Plan
//      额度出现在 GET /api/v1/zcode-plan/billing/balance 的 plans/balances（一次性桶 period=one_time）；
//   3) 交互上报 POST /api/v1/marketing/touch/action（confirm/cancel，best-effort）。
// 鉴权：Authorization: Bearer <zcodejwttoken>（共享凭据，见 auth.mjs）；billing/* 要求
// X-Device-Mid（复用 ZCode 桌面端 telemetry-state.json 的 deviceMid，只读不生成）。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { ResetAuthError } from './reset.mjs'
import { readResponseText } from './gift-adapter.mjs'

export { ResetAuthError }

export const MARKETING_BASE = 'https://zcode.z.ai'
// 营销接口兼容版本（服务端按 app_version 筛选投放）；并非自动读取本机安装版本。
export const ZCODE_APP_VERSION = '3.16.3'

// deviceMid 只读复用 ZCode 桌面端的设备标识；文件由桌面端生命周期负责，这里绝不生成。
const TELEMETRY_FILE = process.env.DMU_ZCODE_TELEMETRY_FILE || path.join(homedir(), '.zcode', 'v2', 'telemetry-state.json')
let deviceMidCache = { value: undefined, at: 0 }

/** 读取 deviceMid（进程内缓存 60s）；缺失/非法返回 undefined，调用方省略该头。 */
export async function readDeviceMid(now = Date.now()) {
  if (deviceMidCache.value !== undefined && now - deviceMidCache.at < 60000) return deviceMidCache.value
  let value
  try {
    const state = JSON.parse(await readFile(TELEMETRY_FILE, 'utf8'))
    const mid = state && typeof state.deviceMid === 'string' ? state.deviceMid.trim() : ''
    // 与 ZCode normalizeZCodeSourceHeaderValue 相同的可打印 ASCII 约束
    value = /^[\x20-\x7e]+$/.test(mid) ? mid : undefined
  } catch { value = undefined }
  deviceMidCache = { value, at: now }
  return value
}

function srcHeaders(session, deviceMid, extra) {
  return {
    authorization: 'Bearer ' + session.zcodeJwt,
    'user-agent': 'ZCode/' + ZCODE_APP_VERSION,
    'x-zcode-app-version': ZCODE_APP_VERSION,
    'x-platform': process.platform + '-' + process.arch,
    'x-client-language': 'zh-CN',
    accept: 'application/json',
    ...(deviceMid ? { 'x-device-mid': deviceMid } : {}),
    ...(extra || {}),
  }
}

// 超时覆盖响应体读取；禁止携带凭据跟随重定向。
async function call(session, fetchImpl, method, urlPath, { query, body, extraHeaders } = {}) {
  const deviceMid = await readDeviceMid()
  const u = new URL(MARKETING_BASE + urlPath)
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v))
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  let res
  let text
  try {
    res = await fetchImpl(u.href, {
      method,
      redirect: 'error',
      headers: srcHeaders(session, deviceMid, extraHeaders),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    // HTTP 失败不读取上游正文，避免错误页/无限流阻塞鉴权恢复。
    if (res.ok) text = await readResponseText(res, { signal: ctl.signal })
  } catch {
    throw new Error(ctl.signal.aborted ? '营销接口请求超时' : '营销接口请求或响应读取失败')
  } finally {
    clearTimeout(timer)
    if (res?.body && !res.body.locked) {
      try { await res.body.cancel() } catch { /* best effort */ }
    }
  }
  if (res.status === 401 || res.status === 403) throw new ResetAuthError('HTTP ' + res.status + '（ZCode 会话已失效）')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  let data
  try { data = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!data || typeof data !== 'object' || !Number.isFinite(data.code)) throw new Error('营销接口响应不是有效 JSON envelope')
  return data
}

// 投放对象内深找 zcode_plan 元数据（banner 在 background.bundle.args，popup 在 hero.bundle.args）
function findZcodePlan(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (value.zcode_plan && typeof value.zcode_plan === 'object') return value.zcode_plan
  for (const v of Object.values(value)) {
    const hit = findZcodePlan(v, depth + 1)
    if (hit) return hit
  }
  return null
}

function normEntitlement(e) {
  if (!e || typeof e !== 'object') return null
  const units = Number(e.grant_units)
  const effectiveSec = Number(e.effective_at)
  const capabilities = (Array.isArray(e.capabilities) ? e.capabilities : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return {
    id: String(e.entitlement_id || ''),
    model: String(e.show_name || ''),
    units: Number.isFinite(units) ? units : 0,
    unitType: String(e.unit_type || 'token'),
    period: String(e.period || ''),
    // 即时发布候选只接受精确线协议 id；展示名不能代替 model id。
    capabilities,
    effectiveAt: Number.isFinite(effectiveSec) && effectiveSec >= 0 ? effectiveSec * 1000 : null,
  }
}

/**
 * 拉取营销投放并归一化出「可领取套餐」列表：
 * [{ campaignId, position, planId, name, priority, endsAt, entitlements: [{ id, model, capabilities, effectiveAt, units, unitType, period }] }]
 * 同一 planId 多资源位去重（取 priority 高者），按 priority 降序。
 */
export async function fetchClaimOffers(session, fetchImpl = fetch) {
  const data = await call(session, fetchImpl, 'GET', '/api/v1/marketing/touch', { query: { seq: 0 } })
  if (data.code !== 0) throw new Error('营销投放接口拒绝（code ' + data.code + '）')
  const d = data.data || {}
  const deliveries = Array.isArray(d.deliveries) ? d.deliveries : []
  const byPlan = new Map()
  for (const raw of deliveries) {
    if (!raw || typeof raw !== 'object') continue
    const position = raw.resource_position === 'popup' ? 'popup' : raw.resource_position === 'banner' ? 'banner' : null
    if (!position) continue
    const slot = position === 'banner' ? raw.banner : raw.popup
    const buttons = slot && Array.isArray(slot.buttons) ? slot.buttons : []
    const claimBtn = buttons.find((b) => b && b.action && b.action.type === 'claim_zcode_plan')
    if (!claimBtn) continue
    const args = (claimBtn.action && claimBtn.action.args) || {}
    const meta = findZcodePlan(raw) || {}
    const endsSec = Number(meta.ends_at)
    const offer = {
      campaignId: String(raw.campaign_id || ''),
      position,
      planId: String(args.plan_id || meta.plan_id || ''),
      name: String(meta.name || ''),
      priority: Number.isFinite(raw.priority) ? raw.priority : 0,
      endsAt: endsSec > 0 ? endsSec * 1000 : null,
      entitlements: (Array.isArray(meta.entitlements) ? meta.entitlements : []).map(normEntitlement).filter(Boolean),
      // 领取成功后的结果弹窗由投放下发；客户端只按 action 执行，不自行伪造成功 Toast。
      successPopup: slot && slot.success_popup && typeof slot.success_popup === 'object' ? slot.success_popup : null,
    }
    if (!offer.planId) continue
    const prev = byPlan.get(offer.planId)
    if (!prev || offer.priority > prev.priority) byPlan.set(offer.planId, offer)
  }
  return [...byPlan.values()].sort((a, b) => b.priority - a.priority)
}

/**
 * 领取套餐。成功（code=0 且 data.plan 存在）返回归一化 plan；
 * 失败文案优先取服务端已翻译的 data.message（与桌面端契约一致，不展示 envelope.msg）。
 */
export async function claimPlan(session, planId, fetchImpl = fetch) {
  const data = await call(session, fetchImpl, 'POST', '/api/v1/zcode-plan/billing/claim', {
    body: { plan_id: String(planId || '') },
    extraHeaders: { 'content-type': 'application/json' },
  })
  if (data.code === 0 && data.data && data.data.plan) {
    const p = data.data.plan
    const serverSec = Number(data.data.server_time)
    const result = { planId: String(p.plan_id || planId), name: String(p.name || ''), raw: p }
    if (Number.isFinite(serverSec) && serverSec > 0) result.serverTime = serverSec * 1000
    return result
  }
  let serverMsg = data.data && typeof data.data.message === 'string' ? data.data.message.trim() : ''
  for (const secret of [session?.zcodeJwt, session?.businessJwt]) {
    if (typeof secret === 'string' && secret) serverMsg = serverMsg.split(secret).join('[redacted]')
  }
  serverMsg = serverMsg.slice(0, 300)
  const err = new Error(serverMsg || '领取失败（code ' + data.code + '）')
  err.bizCode = data.code
  throw err
}

const num = (v) => {
  if (v == null || (typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * 查询赠送额度（Start Plan）余额并归一化：
 * { plans: [{ planId, name, status, endsAt }], buckets: [{ planId, model, unitType, total, used, remaining, expiresAt }] }
 * models 由 giftModelsFromBalances 提取；remaining 以 remaining_units ?? available_units 为准。
 */
export async function fetchGiftBalances(session, fetchImpl = fetch) {
  const data = await call(session, fetchImpl, 'GET', '/api/v1/zcode-plan/billing/balance', { query: { app_version: ZCODE_APP_VERSION } })
  if (data.code !== 0) throw new Error('赠送额度接口拒绝（code ' + data.code + '）')
  const d = data.data || {}
  const now = Date.now()
  const plans = (Array.isArray(d.plans) ? d.plans : []).filter((p) => p && typeof p.plan_id === 'string' && p.plan_id.trim()).map((p) => {
    const endSec = Number(p.ends_at)
    const status = String(p.status || '').trim().toLowerCase()
    // 与 ZCode normalizeStartPlanExpiry 同口径：active 但已过 ends_at 视为 expired
    const expired = Number.isFinite(endSec) && endSec > 0 && endSec * 1000 <= now
    return {
      planId: String(p.plan_id || ''),
      name: String(p.name || ''),
      status: expired ? 'expired' : status || 'unknown',
      endsAt: Number.isFinite(endSec) && endSec > 0 ? endSec * 1000 : null,
    }
  })
  const activePlans = new Map(plans.filter((p) => p.status === 'active').map((p) => [p.planId, p]))
  const buckets = (Array.isArray(d.balances) ? d.balances : [])
    .filter((b) => b && activePlans.has(String(b.plan_id || '')))
    .map((b) => {
      // capabilities 里的 model: 前缀是精确模型 id（与 ZCode resolveZaiStartPlanBalanceModelIds 同规则）
      const caps = Array.isArray(b.capabilities) ? b.capabilities : []
      const modelIds = caps.map((c) => {
        const s = String(c || '').trim()
        return s.toLowerCase().startsWith('model:') ? s.slice(6).trim() : ''
      }).filter(Boolean)
      return {
        planId: String(b.plan_id || ''),
        bucketId: String(b.bucket_id || ''),
        // 展示名不是可调用 id；缺少 capability 的桶保留展示，但不注册模型。
        model: modelIds[0] || '',
        unitType: String(b.unit_type || 'token'),
        total: num(b.total_units),
        used: num(b.used_units),
        remaining: num(b.remaining_units ?? b.available_units),
        expiresAt: (() => {
          const t = Number(b.expires_at)
          const bucketEnd = Number.isFinite(t) && t > 0 ? t * 1000 : null
          const planEnd = activePlans.get(String(b.plan_id || '')).endsAt
          // 缓存中的桶也不能越过所属套餐的截止时间。
          return bucketEnd == null ? planEnd : planEnd == null ? bucketEnd : Math.min(bucketEnd, planEnd)
        })(),
      }
    })
  return { serverTime: (() => { const t = Number(d.server_time); return Number.isFinite(t) && t > 0 ? t * 1000 : null })(), plans, buckets }
}

/**
 * 从赠额余额提取「当前可用的赠送模型」列表（供 llm 候选与卡片展示）：
 * 仅统计有剩余额度（remaining 为 null 视作未知可用）且未过期的桶；同名模型去重。
 */
export function giftModelsFromBalances(balances) {
  const byModel = new Map()
  const now = Date.now()
  for (const b of Array.isArray(balances) ? balances : []) {
    if (!b || typeof b.model !== 'string' || !b.model.trim() || (b.unitType && b.unitType !== 'token')) continue
    const exhausted = b.remaining != null && b.remaining <= 0
    const expired = b.expiresAt != null && b.expiresAt <= now
    if (!b.model || exhausted || expired) continue
    const prev = byModel.get(b.model)
    if (!prev) byModel.set(b.model, { id: b.model, remaining: b.remaining, total: b.total, expiresAt: b.expiresAt, unitType: b.unitType })
    else {
      if (b.remaining != null) prev.remaining = prev.remaining == null ? b.remaining : prev.remaining + b.remaining
      if (b.total != null) prev.total = prev.total == null ? b.total : prev.total + b.total
      if (b.expiresAt != null) prev.expiresAt = prev.expiresAt == null ? b.expiresAt : Math.max(prev.expiresAt, b.expiresAt)
    }
  }
  return [...byModel.values()]
}

/** 交互上报（confirm/cancel）。best-effort：任何失败返回 false，由调用方吞掉。 */
export async function reportTouchAction(session, campaignId, actionType, fetchImpl = fetch) {
  try {
    const result = await call(session, fetchImpl, 'POST', '/api/v1/marketing/touch/action', {
      body: { campaign_id: String(campaignId || ''), action_type: actionType === 'confirm' ? 'confirm' : 'cancel' },
      extraHeaders: { 'content-type': 'application/json' },
    })
    return result.code === 0
  } catch { return false }
}
