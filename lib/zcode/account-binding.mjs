// 账户归属只由当前登录态可读取的完整 API Key 证明；所有凭据与响应仅留在 Host 内存。
import { createHash, timingSafeEqual } from 'node:crypto'
import { readResponseText } from './gift-adapter.mjs'

const ORIGINS = { bigmodel: 'https://bigmodel.cn', zai: 'https://api.z.ai' }
const MAX_PROJECTS = 32
const MAX_BYTES = 2 * 1024 * 1024
const FAILURE_TTL = 30000
const PAGINATION_FIELDS = new Set([
  'page', 'pageno', 'pagenum', 'pagenumber', 'pagesize', 'pages', 'total', 'totalcount',
  'totalpages', 'hasmore', 'hasnext', 'next', 'nextpage', 'nextcursor', 'cursor',
  'pagination', 'paging', 'offset', 'limit',
])
const unavailable = () => ({ status: 'unavailable', matchingRoutes: [] })
const copyResult = (result) => ({ status: result.status, matchingRoutes: [...result.matchingRoutes] })
const digest = (value) => createHash('sha256').update(value).digest()
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const masked = (value) => /\*|\.{3}|…|⋯/.test(value)
const part = (value) => nonempty(value) && !/[.\s]/.test(value) && !masked(value)
const isTeam = (value) => String(value ?? '').trim() === '2'
const invalid = () => { throw new Error('account_binding_unavailable') }

function keyParts(value) {
  if (typeof value !== 'string' || masked(value)) return null
  const parts = value.split('.')
  return parts.length === 2 && parts.every(part) ? parts : null
}

// 未实现分页协议时不把部分结果当完整清单；包括 envelope 上的分页提示。
function hasPagination(value, allowCompleteTotal = false) {
  return record(value) && Object.keys(value).some((key) => {
    // BigModel 实测数组 envelope 带 total；只有条数完全吻合时才确认为完整清单。
    if (allowCompleteTotal && key === 'total' && Array.isArray(value.data) && Number.isSafeInteger(value.total) && value.total === value.data.length) return false
    return PAGINATION_FIELDS.has(key.replace(/[_-]/g, '').toLowerCase()) && value[key] != null
  })
}

function personalProjects(customer) {
  if (!record(customer) || !Array.isArray(customer.organizations) || hasPagination(customer)) invalid()
  const projects = new Map()
  for (const organization of customer.organizations) {
    if (!record(organization) || !nonempty(organization.organizationId) ||
        !Array.isArray(organization.projects) || hasPagination(organization)) invalid()
    for (const project of organization.projects) {
      if (!record(project) || (project.projectType != null &&
          !['string', 'number'].includes(typeof project.projectType))) invalid()
      if (isTeam(project.projectType)) continue
      if (!nonempty(project.projectId) || hasPagination(project)) invalid()
      const location = { organizationId: organization.organizationId, projectId: project.projectId }
      projects.set(JSON.stringify(location), location)
      if (projects.size > MAX_PROJECTS) invalid()
    }
  }
  return [...projects.values()]
}

async function discover(session, candidates, fetchImpl, signal) {
  const relevant = candidates.filter((candidate) => candidate.family === session.businessFamily)
  if (!relevant.length) return { status: 'unmatched', matchingRoutes: [] }
  const wanted = new Map()
  for (const candidate of relevant) {
    const parts = keyParts(candidate.apiKey)
    if (!nonempty(candidate.route) || !parts) invalid()
    const item = { route: candidate.route, hash: digest(candidate.apiKey) }
    const entries = wanted.get(parts[0]) || []
    entries.push(item)
    wanted.set(parts[0], entries)
  }
  const origin = ORIGINS[session.businessFamily]
  const token = session.businessJwt.trim().replace(/^Bearer\s+/i, '')
  if (!token) invalid()
  const keyAuthorization = session.businessFamily === 'zai' ? 'Bearer ' + token : token
  const request = async (url, authorization) => {
    signal.throwIfAborted()
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: authorization, accept: 'application/json', 'content-type': 'application/json' },
      redirect: 'error',
      signal,
    })
    signal.throwIfAborted()
    if (!response?.ok || response.redirected || (response.status >= 300 && response.status < 400)) invalid()
    const link = response.headers?.get('link') || ''
    if (/rel\s*=\s*["']?next\b/i.test(link)) invalid()
    for (const header of ['content-range', 'x-total-count', 'x-total-pages', 'x-page', 'x-per-page',
      'x-next-page', 'x-pagination-total-count', 'x-pagination-page-count', 'x-pagination-current-page']) {
      if (response.headers?.has(header)) invalid()
    }
    const raw = JSON.parse(await readResponseText(response, { signal, maxBytes: MAX_BYTES }))
    signal.throwIfAborted()
    if (!record(raw) || raw.success === false || ![0, 200, '0', '200'].includes(raw.code) || hasPagination(raw, true)) invalid()
    return raw.data
  }
  const customer = await request(origin + '/api/biz/customer/getCustomerInfo', token)
  const locations = personalProjects(customer)
  const matches = new Set()
  for (const location of locations) {
    const url = origin + '/api/biz/v1/organization/' + encodeURIComponent(location.organizationId) +
      '/projects/' + encodeURIComponent(location.projectId) + '/api_keys'
    const keys = await request(url, keyAuthorization)
    if (!Array.isArray(keys)) invalid()
    const copied = new Map()
    for (const key of keys) {
      if (!record(key) || (key.keyType != null && !['string', 'number'].includes(typeof key.keyType))) invalid()
      if (isTeam(key.keyType)) continue
      if (!nonempty(key.apiKey) || hasPagination(key)) invalid()
      const full = keyParts(key.apiKey)
      const id = full ? full[0] : key.apiKey
      if (!full && !part(id)) invalid()
      const entries = wanted.get(id)
      if (!entries) continue // 不复制无关 Key；列表中的 secretKey 可能是掩码，不能证明归属。
      let material = full ? key.apiKey : copied.get(id)
      if (!material) {
        const value = await request(url + '/copy/' + encodeURIComponent(id), keyAuthorization)
        if (!record(value) || (Object.hasOwn(value, 'apiKey') && value.apiKey !== id) ||
            !part(value.secretKey) || isTeam(value.keyType)) invalid()
        material = id + '.' + value.secretKey
        copied.set(id, material)
      }
      const hash = digest(material)
      for (const entry of entries) {
        if (timingSafeEqual(hash, entry.hash)) matches.add(entry.route)
      }
    }
  }
  signal.throwIfAborted()
  const matchingRoutes = [...matches]
  return { status: matchingRoutes.length > 1 ? 'ambiguous' : matchingRoutes.length ? 'matched' : 'unmatched', matchingRoutes }
}

/** GET-only 身份查询；缓存只保存摘要和公开结果，失效同时取消在途请求。 */
export function createAccountBinding({ fetchImpl = fetch, now = Date.now, ttlMs = 300000, timeoutMs = 15000 } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 300000
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 15000) : 15000
  let generation = 0
  let signature = null
  let cache = null
  let inflight = null

  function invalidate() {
    generation++
    signature = null
    cache = null
    const previous = inflight
    inflight = null
    previous?.controller.abort()
  }

  async function resolve(session, candidates) {
    let currentSession, currentCandidates, nextSignature
    try {
      if (!record(session) || !Object.hasOwn(ORIGINS, session.businessFamily) ||
          !nonempty(session.zcodeJwt) || !nonempty(session.businessJwt) || !Array.isArray(candidates)) invalid()
      currentSession = { zcodeJwt: session.zcodeJwt, businessJwt: session.businessJwt, businessFamily: session.businessFamily }
      currentCandidates = candidates.map((candidate) => {
        if (!record(candidate) || !nonempty(candidate.route) || typeof candidate.family !== 'string' ||
            typeof candidate.apiKey !== 'string') invalid()
        return { route: candidate.route, family: candidate.family, apiKey: candidate.apiKey }
      })
      nextSignature = digest(JSON.stringify([currentSession, currentCandidates])).toString('hex')
    } catch {
      invalidate()
      return unavailable()
    }
    if (signature !== nextSignature) {
      invalidate()
      signature = nextSignature
    }
    const currentGeneration = generation
    const currentResult = (result) => currentGeneration === generation && signature === nextSignature
      ? copyResult(result) : unavailable()
    if (cache && now() < cache.expiresAt) return currentResult(cache.result)
    if (inflight) return currentResult(await inflight.promise)

    const controller = new AbortController()
    const pending = { controller, promise: null }
    inflight = pending
    pending.promise = (async () => {
      let onAbort
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('account_binding_unavailable'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const timer = setTimeout(() => controller.abort(), timeout)
      let result
      try {
        // race 也约束不响应 abort 的 fetch 替身/流；后续请求仍逐次检查 signal。
        result = await Promise.race([discover(currentSession, currentCandidates, fetchImpl, controller.signal), aborted])
      } catch {
        controller.abort()
        result = unavailable()
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
      }
      if (currentGeneration !== generation || signature !== nextSignature) return unavailable()
      cache = { result, expiresAt: now() + (result.status === 'unavailable' ? FAILURE_TTL : ttl) }
      return result
    })().finally(() => {
      if (inflight === pending) inflight = null
    })
    return currentResult(await pending.promise)
  }

  return { resolve, invalidate }
}
