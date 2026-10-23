// dsh-model-usage · GLM Coding Plan 额度重置客户端（仅 GLM 卡片使用）
// 端点为 ZCode Server（https://zcode.z.ai/api/v1/coding-plan/reset/*），
// 鉴权：Authorization: Bearer <zcodeJwt> + X-Bigmodel-Authorization: <业务JWT>（直传不套 Bearer）。
// 凭证获取见 lib/zcode/auth.mjs；凭据不出本模块。
// 参考契约：ZCode 仓库 docs/coding-plan-quota-reset-ui.md（v1 仅实现 PERSONAL scope）。
import { randomUUID } from 'node:crypto'

export const ZCODE_API = 'https://zcode.z.ai'

function headers(session) {
  return {
    authorization: 'Bearer ' + session.zcodeJwt,
    'x-bigmodel-authorization': session.businessJwt,
    'bigmodel-target-type': 'PERSONAL',
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

export class ResetAuthError extends Error {
  constructor(message) { super(message); this.code = 'model-usage/reset-auth' }
}

/** 读 envelope JSON（15s 超时）；401/403 抛 ResetAuthError；
 *  非 2xx 但带 envelope 时优先按 code 判定（与 ZCode 契约一致）；
 *  allowBizCodes 列出的业务码按正常响应返回（opportunity 的 3301 限流）。 */
async function call(session, fetchImpl, method, path, body, allowBizCodes) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  let res
  try {
    res = await fetchImpl(ZCODE_API + path, {
      method,
      headers: headers(session),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  if (res.status === 401 || res.status === 403) throw new ResetAuthError('HTTP ' + res.status + '（ZCode 会话已失效）')
  if (!data || typeof data !== 'object' || typeof data.code !== 'number') {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    throw new Error('重置接口响应不是 JSON')
  }
  if (data.code === 0) return data.data || {}
  if (allowBizCodes && allowBizCodes.includes(data.code)) return data.data || {}
  const err = new Error('重置接口拒绝（code ' + data.code + '）')
  err.bizCode = data.code
  throw err
}

/** 最早到期时刻（毫秒）；空数组返回 null。 */
function earliest(list) {
  const times = (Array.isArray(list) ? list : []).map((x) => Number(x && x.expire_at) || 0).filter((t) => t > 0)
  return times.length ? Math.min.apply(null, times) : null
}

/**
 * 查询重置状态并归一化：
 * { fiveHour: { count, earliestExpireAt }, week: { count, earliestExpireAt }, fiveHourUsedAt, weekUsedAt }
 */
export async function fetchResetStatus(session, fetchImpl = fetch) {
  const d = await call(session, fetchImpl, 'GET', '/api/v1/coding-plan/reset/status')
  const five = Array.isArray(d.available_five_hour_resets) ? d.available_five_hour_resets : []
  const week = Array.isArray(d.available_week_resets) ? d.available_week_resets : []
  return {
    fiveHour: { count: five.length, earliestExpireAt: earliest(five) },
    week: { count: week.length, earliestExpireAt: earliest(week) },
    fiveHourUsedAt: (d.latest_five_hour_reset_history && Number(d.latest_five_hour_reset_history.used_at)) || null,
    weekUsedAt: (d.latest_week_reset_history && Number(d.latest_week_reset_history.used_at)) || null,
  }
}

/**
 * 无有效机会时触发一次服务端资格判断（scope 级，一次覆盖两类），再回读 status。
 * granted=false 时返回 { status, nextTryAt } 由调用方冷却。
 */
export async function fetchResetStatusWithOpportunity(session, fetchImpl = fetch) {
  let status = await fetchResetStatus(session, fetchImpl)
  if (status.fiveHour.count > 0 || status.week.count > 0) return { status, nextTryAt: null }
  // 3301 = 服务端限流：granted=false + next_try_at，属业务响应而非错误
  const r = await call(session, fetchImpl, 'POST', '/api/v1/coding-plan/reset/opportunity', { idempotency_key: randomUUID() }, [3301])
  if (r.granted === true) {
    status = await fetchResetStatus(session, fetchImpl)
    return { status, nextTryAt: null }
  }
  return { status, nextTryAt: Number(r.next_try_at) || null }
}

/**
 * 核销一次重置机会。type: 'FIVE_HOUR' | 'WEEK'。
 * idempotencyKey 由调用方生成并保留（失败重试复用同一 key，成功清除）。
 */
export async function useReset(session, type, idempotencyKey, fetchImpl = fetch) {
  await call(session, fetchImpl, 'POST', '/api/v1/coding-plan/reset/use', {
    idempotency_key: idempotencyKey || randomUUID(),
    reset_type: type === 'WEEK' ? 'WEEK' : 'FIVE_HOUR',
  })
  return true
}
