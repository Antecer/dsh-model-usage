// dsh-model-usage · Host 半区
// 职责：Cordis 插件入口、/model-usage 前缀路由（connection.admit 认证围栏）、
// 额度快照编排（并行取数/缓存/单飞/退避/代际失效、统一 fetchedAt、窗口排序）、
// 本机用量统计输出（ledger：今日/本周/本月/全部摘要、364 天热力图、按会话/按日聚合）、
// GLM 额度重置编排（ZCode 共享会话、机会状态缓存与冷却、核销幂等）、sub2api 探测。
import { adapterFor, resolveSub2api, resolveKey, safeMsg } from './adapters.mjs'
import { createLedger } from './ledger.mjs'
import { resolveSession, clearSession, saveSession } from './zcode/auth.mjs'
import { fetchResetStatus, fetchResetStatusWithOpportunity, useReset, ResetAuthError } from './zcode/reset.mjs'
import { fetchClaimOffers, claimPlan, reportTouchAction } from './zcode/marketing.mjs'
import { fetchGiftBalances, giftModelsFromBalances } from './zcode/marketing.mjs'
import { GiftModelAdapter, GIFT_PROVIDER, createGiftFallback } from './zcode/gift-adapter.mjs'
import { createAccountBinding } from './zcode/account-binding.mjs'
import { newLoginState, buildAuthorizeUrl, parseCallbackInput, exchangeCode } from './zcode/login.mjs'
import { createPricingService, PRICING_DEFAULTS } from './pricing.mjs'
import { createVersionService } from './version.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS_DIR = join(PKG_DIR, 'assets', 'icons')
const STYLE_FILE = join(PKG_DIR, 'assets', 'style.css')

const DEFAULTS = {
  refreshSeconds: 60,
  footer: true,
  credentials: {},
  adapters: {},
  glm: {},
  sub2api: {},
  card: {},
  pricing: PRICING_DEFAULTS,
}

export const name = '@antecer/dsh-model-usage'

const prettyNames = {
  'deepseek-official': 'DeepSeek',
  'deepseek-account': 'DeepSeek 账号',
  'zai-coding-cn': 'GLM Coding Plan',
  zai: 'GLM Coding (国际)',
}

/**
 * 合并 pricing 配置：外层与 models 均逐层回落默认值，用户只写想覆盖的字段即可。
 * @param {object} base 官方默认定价（PRICING_DEFAULTS）
 * @param {object} over 用户配置（cordis.patch.yml 的 pricing）
 */
function mergePricing(base, over) {
  const patch = over && typeof over === 'object' ? over : {}
  const cfg = { ...base, ...patch }
  const models = {}
  const names = new Set([...Object.keys(base.models || {}), ...Object.keys(patch.models || {})])
  for (const name of names) {
    const b = (base.models || {})[name] || {}
    const o = (patch.models || {})[name] || {}
    const merge = (kind) => ({ ...(b[kind] || {}), ...(o[kind] || {}) })
    models[name] = { ...b, ...o, cacheHit: merge('cacheHit'), cacheMiss: merge('cacheMiss'), output: merge('output') }
  }
  return { ...cfg, models }
}

export function apply(ctx, rawConfig) {
  const raw = rawConfig || {}
  const config = { ...DEFAULTS, ...raw }
  for (const k of ['credentials', 'adapters', 'glm', 'sub2api', 'card']) config[k] = { ...(raw[k] || {}) }
  config.pricing = mergePricing(PRICING_DEFAULTS, raw.pricing)
  config.refreshSeconds = Math.max(1, Number(config.refreshSeconds) || 60)

  const ok = (value) => ({ ok: true, value })
  const fail = (code, message) => ({ ok: false, error: { code, message: safeMsg(message) } })

  const state = {
    cache: new Map(),        // route -> { inflight, at, backoffUntil, backoff, data, gen }
    probe: new Map(),        // route -> 'sub2api' | 'none'（探测结论缓存）
    probeInfo: new Map(),    // route -> { baseURL, apiKeyEnv }
    profile: null,           // profile 供应商表（{ route: { baseURL, apiKeyEnv, displayName } }）
    profileAt: 0,
    generation: 0,           // 配置/供应商变更代际：旧代际的在途结果被丢弃
    lastActive: null,        // { route, ts } 最近一次真实模型调用
  }
  let quotaScope = null
  let scopeGeneration = 0
  let publishingGift = false
  const ledger = createLedger()
  const pricingService = createPricingService(config)
  const versionService = createVersionService(PKG_DIR)

  const getAccount = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch { return null }
  }

  /** 可选服务必须用 get()；部分宿主以普通上下文元数据提供 profileContext，独立兼容该形态。 */
  function profileDirectory() {
    let profile
    try { profile = ctx.get('profileContext') } catch { /* 可选服务尚未提供 */ }
    if (!profile) {
      try { profile = ctx.profileContext } catch { /* 普通元数据不存在；不能阻断 pluginManager/env 回落 */ }
    }
    if (typeof profile?.dir === 'string' && profile.dir) return profile.dir
    try { return ctx.get('pluginManager')?.profile?.dir } catch { return undefined }
  }

  /** 读取 profile 供应商表（profile.js 自带 60s 缓存；配置变更时随代际清空）。routes 用于无环境变量时识别当前 profile。 */
  async function ensureProfile(routes) {
    if (!state.profile || Date.now() - state.profileAt >= 60000) {
      try {
        const { profileProviders } = await import('./profile.mjs')
        state.profile = await profileProviders(routes, profileDirectory())
      } catch { state.profile = {} }
      state.profileAt = Date.now()
    }
    return state.profile
  }

  /**
   * 组装适配器调用环境。凭据引用优先级：
   * 显式 config.credentials > provider 自己的 apiKeyEnv（profile 配置，存在即唯一来源，
   * 不回退到适配器默认引用，避免串号到别的账号）> 适配器默认 > 路由名派生。
   */
  async function makeEnv(ad, route) {
    const probe = state.probeInfo.get(route) || {}
    const prof = (state.profile && state.profile[route]) || {}
    const refs = []
    const push = (r) => { if (r && !refs.includes(r)) refs.push(r) }
    const providerKey = probe.apiKeyEnv || prof.apiKeyEnv
    if (config.credentials[route]) {
      push(config.credentials[route])
    } else if (providerKey) {
      push(providerKey)
    } else {
      for (const r of ad.refs(config, route) || []) push(r)
      push(String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_API_KEY')
    }
    return {
      ctx: quotaScope,
      credentials: quotaScope ? quotaScope.credentials : undefined,
      getAccount,
      config,
      route,
      refs,
      providerBaseURL: prof.baseURL || null,
      baseURL: probe.baseURL || (config.sub2api[route] && config.sub2api[route].baseURL) || prof.baseURL || null,
    }
  }

  async function getUsage(ad, route, force) {
    let c = state.cache.get(route)
    if (!c) {
      c = { inflight: null, at: 0, backoffUntil: 0, backoff: 0, data: null, gen: state.generation }
      state.cache.set(route, c)
    }
    if (c.inflight) return c.inflight
    const now = Date.now()
    if (!force && c.data && now - c.at < config.refreshSeconds * 1000) return { data: c.data, fresh: false }
    if (!force && now < c.backoffUntil && c.data) return { data: { ...c.data, status: 'stale', stale: true }, fresh: false }

    const gen = state.generation
    const p = (async () => {
      let fresh = false
      try {
        const d = await ad.read(await makeEnv(ad, route))
        if (gen !== state.generation) return { data: c.data, fresh: false } // 代际已变：丢弃过期在途结果
        d.route = route
        d.adapter = ad.id
        d.fetchedAt = d.fetchedAt || Date.now()
        c.data = d
        fresh = true
        c.at = Date.now()
        c.backoffUntil = 0
        c.backoff = 0
      } catch (e) {
        if (gen !== state.generation) return { data: c.data, fresh: false }
        c.at = Date.now()
        c.backoff = c.backoff ? Math.min(300000, c.backoff * 2) : 60000
        c.backoffUntil = Date.now() + c.backoff
        const error = { code: (e && e.code) || 'model-usage/fetch-failed', message: safeMsg(e) }
        c.data = c.data
          ? { ...c.data, status: 'stale', stale: true, error }
          : { route, adapter: ad.id, status: 'error', error }
      } finally {
        if (c.inflight === p) c.inflight = null
      }
      return { data: c.data, fresh }
    })()
    c.inflight = p
    return p
  }

  /** 为路由解析适配器：显式/URL/路由名匹配优先；未命中时按 profile/显式配置探测 sub2api（结论缓存）。 */
  async function resolveAdapter(route) {
    const profile = await ensureProfile([route])
    const builtin = adapterFor(route, config, profile[route])
    if (builtin) return builtin
    // 显式指定了未知模板：不探测、不显示（配置错误应静默隐藏而非误连中继）
    if (config.adapters[route]) {
      state.probe.set(route, 'none')
      return null
    }
    if (state.probe.get(route) === 'none') return null
    if (state.probe.get(route) === 'sub2api') return state.probeInfo.get(route).adapter
    const found = await resolveSub2api(route, config)
    if (!found) {
      state.probe.set(route, 'none')
      return null
    }
    state.probeInfo.set(route, found)
    state.probe.set(route, 'sub2api')
    return found.adapter
  }

  function prettyName(p, profile) {
    const prof = profile && profile[p.id]
    const custom = [prof && prof.displayName, p.displayName, p.name].find((v) => typeof v === 'string' && v.trim() && v !== p.id)
    return custom || prettyNames[p.id] || p.name || p.id
  }

  /** 赠送分组名：前缀同步自关联 GLM provider，后缀固定「 · 赠送」（重复调用保持幂等）。 */
  function giftGroupName(base) {
    const text = typeof base === 'string' ? base.trim() : ''
    if (!text) return '智谱 · 赠送'
    return text.replace(/\s*·\s*赠送$/, '') + ' · 赠送'
  }

  /** 分组名不是账户证明；自动绑定仅采用登录账户完整 Key 与 provider 凭据的精确匹配。 */
  async function associatedGlmRoute(providers, profile, session) {
    const glm = providers.filter((p) => p.adapter === 'glm-coding')
    const configured = typeof config.glm.giftProvider === 'string' ? config.glm.giftProvider.trim() : ''
    if (configured) {
      const parentRoute = glm.some((p) => p.route === configured) ? configured : null
      return { parentRoute, status: parentRoute ? 'configured' : 'unavailable' }
    }
    if (!session?.businessJwt || !session.businessFamily) return { parentRoute: null, status: 'unavailable' }
    const candidates = []
    for (const p of glm) {
      const prof = profile[p.route] || {}
      let family
      if (prof.baseURL) {
        try {
          const url = new URL(prof.baseURL)
          if (url.protocol !== 'https:' || url.username || url.password) continue
          family = url.hostname === 'open.bigmodel.cn' ? 'bigmodel' : url.hostname === 'api.z.ai' ? 'zai' : null
        } catch { continue }
      } else family = p.route === 'zai-coding-cn' ? 'bigmodel' : p.route === 'zai' ? 'zai' : null
      if (family !== session.businessFamily) continue
      // 自定义路由必须有明确凭据引用，不能借用另一个账户的全局默认 Key 来证明归属。
      if (!config.credentials[p.route] && !prof.apiKeyEnv && !['zai-coding-cn', 'zai'].includes(p.route)) continue
      const ad = adapterFor(p.route, config, prof)
      if (!ad) continue
      const apiKey = await resolveKey(await makeEnv(ad, p.route))
      if (typeof apiKey === 'string' && apiKey.trim()) candidates.push({ route: p.route, family, apiKey: apiKey.trim() })
    }
    const result = await accountBinding.resolve(session, candidates)
    return {
      parentRoute: result.status === 'matched' && result.matchingRoutes.length === 1 ? result.matchingRoutes[0] : null,
      status: result.status,
    }
  }

  /**
   * DSH 没有 provider 排序 API：直接调整 llm 注册表（Map）顺序，把 glm-gift 放到关联 GLM 路由之后。
   * 只改展示顺序，不改路由/鉴权；注册表结构变化时静默跳过，不影响功能。
   */
  function keepGiftAfterGlm(llm, glmRoute) {
    const map = llm && llm.adapters
    if (!(map instanceof Map) || !glmRoute || !map.has(glmRoute) || !map.has(GIFT_PROVIDER)) return false
    const ids = [...map.keys()]
    const giftIndex = ids.indexOf(GIFT_PROVIDER)
    const glmIndex = ids.indexOf(glmRoute)
    if (glmIndex < 0 || giftIndex === glmIndex + 1) return false
    const registration = map.get(GIFT_PROVIDER)
    // 仅操作本插件持有的注册；宿主字段不兼容时保留原顺序。
    if (registration?.adapter !== giftBox.adapter) return false
    const entries = [...map.entries()]
    if (entries.some(([id, value]) => value?.provider?.id !== id)) return false
    const tail = entries.slice(glmIndex + 1).filter(([id]) => id !== GIFT_PROVIDER)
    map.delete(GIFT_PROVIDER)
    for (const [id] of tail) map.delete(id)
    map.set(GIFT_PROVIDER, registration)
    for (const [id, value] of tail) map.set(id, value)
    return true
  }

  // 自己发布目录变化时不清空供应商额度缓存；外部拓扑变更仍正常失效。
  function publishGiftChange(action) {
    const previous = publishingGift
    publishingGift = true
    try { return action() } finally { publishingGift = previous }
  }

  /** dispatch 返回订阅者列表，须逐一执行；异步失败不可成为未处理 rejection。 */
  function notifyAdaptersUpdated() {
    publishGiftChange(() => {
      try {
        if (ctx.events && typeof ctx.events.dispatch === 'function') {
          for (const listener of ctx.events.dispatch('emit', ['llm/adapters-updated'])) {
            try { Promise.resolve(listener()).catch((error) => warnGiftSync('通知', error)) }
            catch (error) { warnGiftSync('通知', error) }
          }
        } else if (typeof ctx.emit === 'function') {
          Promise.resolve(ctx.emit('llm/adapters-updated')).catch((error) => warnGiftSync('通知', error))
        }
      } catch (error) { warnGiftSync('通知', error) }
    })
  }

  // 窗口展示顺序统一为时长最短在前：5h > 日 > 周 > 月（MCP/月 归入月度）；
  // 各适配器返回顺序不一（kimi 周在前、sub2api 取决于上游数组），在此集中排序，
  // 未知 key 稳定排在已知窗口之后。
  const WINDOW_ORDER = { rolling: 0, daily: 1, weekly: 2, monthly: 3, mcp: 3 }
  function sortWindows(ws) {
    if (!Array.isArray(ws) || ws.length < 2) return ws
    const rank = (w) => (w && Object.hasOwn(WINDOW_ORDER, w.key) ? WINDOW_ORDER[w.key] : 4)
    return ws.map((w, i) => [w, i]).sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1])).map(([w]) => w)
  }

  async function buildSnapshot(force, route = null) {
    let routes = []
    try {
      const llm = quotaScope && quotaScope.llm
      routes = (llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []).map((p) => ({ id: p.id, name: p.name, displayName: p.displayName }))
    } catch { /* llm 不可用 */ }
    const profile = await ensureProfile(routes.map((r) => r.id))
    const snapshotScope = scopeGeneration

    // 并行取数：串行会让先完成的供应商等到最慢的一个，卡片「刚刷新就显示十几秒前」
    const results = await Promise.all(routes.map(async (r) => {
      const base = { route: r.id, displayName: prettyName(r, profile) }
      const ad = await resolveAdapter(r.id)
      if (!ad) return null // 无额度接口的供应商不显示
      const { data, fresh } = await getUsage(ad, r.id, force && (route === null || route === r.id))
      return data ? { provider: { ...base, ...data }, data, fresh } : null
    }))
    // 只更新本轮实际查询的结果；时间戳相等不能证明发生了查询（缓存命中也可能在同一毫秒）。
    const doneAt = Date.now()
    const providers = []
    for (const result of results) {
      if (!result) continue
      const p = result.provider
      p.windows = sortWindows(p.windows)
      if (result.fresh) {
        p.fetchedAt = doneAt
        const c = state.cache.get(p.route)
        if (c && c.data === result.data) c.data.fetchedAt = doneAt
      }
      providers.push(p)
    }
    // GLM 重置机会仅在有 GLM 卡片时拉取（账号级状态，失败不影响快照）
    if (snapshotScope === scopeGeneration && providers.some((p) => p.adapter === 'glm-coding')) {
      const resetStatus = await getResetStatus().catch(() => undefined)
      const resetSession = await getResetSession().catch(() => null)
      const claimOffers = await getClaimOffers().catch(() => [])
      const bindingGeneration = giftBox.bindingGeneration
      const sessionGeneration = resetBox.sessionGeneration
      // 检查新凭据期间禁止用旧关联触发到期回退。
      giftBox.associatedRoute = null
      const binding = await associatedGlmRoute(providers, profile, resetSession)
      const associatedRoute = binding.parentRoute
      const associated = providers.find((p) => p.route === associatedRoute)
      if (snapshotScope !== scopeGeneration || bindingGeneration !== giftBox.bindingGeneration || sessionGeneration !== resetBox.sessionGeneration) {
        return { generatedAt: doneAt, providers: [], giftProvider: { route: GIFT_PROVIDER, parentRoute: null, bindingStatus: 'unavailable' } }
      }
      giftBox.bindingStatus = binding.status
      giftBox.associatedRoute = associatedRoute || null
      giftBox.glmDisplayName = associated ? (associated.displayName || associated.route || '') : ''
      const gift = await getGiftBalances(force).catch(() => null)
      await syncGiftAdapter().catch(() => {})
      for (const p of providers) {
        if (p.route !== associatedRoute) continue
        p.zcodeConnected = !!(resetSession || resetStatus)
        if (resetStatus) p.resets = resetStatus
        if (claimOffers && claimOffers.length) p.claimOffers = claimOffers
        if (gift && p.route === associatedRoute) {
          const giftModels = giftModelsFromBalances(gift.buckets)
          p.gift = { models: giftModels, buckets: gift.buckets, plans: gift.plans }
        }
      }
    } else if (snapshotScope === scopeGeneration) {
      giftBox.associatedRoute = null
      giftBox.glmDisplayName = ''
      disposeGiftAdapter()
    }
    return {
      generatedAt: doneAt,
      refreshSeconds: config.refreshSeconds,
      card: { template: typeof config.card.template === 'string' ? config.card.template : '' },
      providers,
      giftProvider: { route: GIFT_PROVIDER, parentRoute: giftBox.associatedRoute, bindingStatus: giftBox.bindingStatus },
    }
  }

  // ---- GLM 额度重置（仅 GLM 卡片；会话复用 ZCode 应用 > 内嵌登录）
  // 测试接缝：config.sessionResolver / config.resetFetch 可注入替身
  const sessionResolver = config.sessionResolver || resolveSession
  const resetFetch = config.resetFetch || fetch
  const accountBinding = createAccountBinding({ fetchImpl: config.accountFetch || resetFetch })
  const resetBox = {
    session: undefined, sessionAt: 0, sessionGeneration: 0, inflight: null,   // undefined = 未探测
    status: null, statusAt: 0,          // 重置机会状态缓存（5 分钟 TTL）
    nextTryAt: 0,                       // opportunity 限流冷却（服务端 next_try_at）
    pendingLogin: null,                 // 内嵌登录的待发 state
    idemKeys: {},                       // type -> 幂等 key（失败重试复用，成功清除）
  }

  // ---- 营销投放（GLM 卡片「可领取额度」）：touch 投放缓存（5 分钟 TTL）+ 已关闭活动集合
  // 投放缓存与 reset 状态同节奏：只在快照含 GLM 卡片时拉取，失败静默不影响额度快照。
  const marketingBox = {
    offers: null, offersAt: 0,   // null = 未探测；[] = 当前无投放
    // X 只在客户端当前实例临时隐藏；插件不提供 cancel RPC，避免账号级投放副作用。
  }

  /** 读取可领取套餐；无会话返回 []；拉取失败保留旧值直至 TTL 过期。 */
  async function getClaimOffers() {
    const session = await getResetSession()
    if (!session) { marketingBox.offers = null; marketingBox.offersAt = Date.now(); return [] }
    const gen = resetBox.sessionGeneration
    const now = Date.now()
    if (marketingBox.offers && now - marketingBox.offersAt < 300000) return marketingBox.offers
    try {
      const all = await fetchClaimOffers(session, resetFetch)
      if (gen !== resetBox.sessionGeneration) return []
      marketingBox.offers = all
      marketingBox.offersAt = Date.now()
    } catch {
      if (gen !== resetBox.sessionGeneration) return []
      if (!marketingBox.offers) { marketingBox.offers = []; marketingBox.offersAt = now }
    }
    return marketingBox.offers
  }

  // ---- 赠送额度（Start Plan）：余额缓存 + llm 候选适配器生命周期
  // 领取成功 → 桶出现 → 注册 glm-gift 路由适配器（模型进入 DSH 候选）；
  // 桶耗尽 / 套餐到期 → 模型列表为空 → 自动注销（GUI 经 llm/adapters-updated 刷新）。
  const giftBox = {
    llm: null,        // quotaScope 注入的 llm 服务引用
    disposer: null,   // registerAdapter 返回句柄；调用即注销
    adapter: null,
    expiryTimer: null,
    expiryBuckets: new Map(), // 到期证据：余额接口可能在截止后移除桶，不能丢掉已知截止时间
    fallback: null,
    modelSignature: '', // 已发布的模型 id 签名（排序后序列化，忽略余额数量与桶顺序）
    lastError: '',    // 最近一次已告警错误（同错误不重复刷日志）
    balances: null,   // 最近一次 fetchGiftBalances 归一化结果
    balancesAt: 0,    // 0 = 需要重查
    inflight: null,   // 普通快照共享查询；force 请求可以取代旧代际
    balancesGen: 0,   // 余额响应代际：仅最新一代允许回写，防止旧响应覆盖新权益
    providerName: '智谱 · 赠送', // 赠额分组名（前缀随关联 GLM provider 同步）
    glmDisplayName: '', // 关联 GLM 卡片的展示名（用于生成分组名）
    bindingGeneration: 0,
    bindingStatus: 'unavailable',
    associatedRoute: null, // 关联 GLM provider 路由（用于卡片归属与候选排序）
  }

  function rememberGiftExpiry(value) {
    for (const bucket of value?.buckets || []) {
      if (!bucket.model) continue
      const key = JSON.stringify([bucket.planId, bucket.bucketId, bucket.model])
      giftBox.expiryBuckets.set(key, { ...bucket })
    }
  }

  /** 余额请求单飞；失败也冷却，断开或作用域销毁后迟到响应不得回写。 */
  async function getGiftBalances(force) {
    const now = Date.now()
    if (!force && giftBox.inflight) return giftBox.inflight
    if (!force && giftBox.balancesAt && now - giftBox.balancesAt < 60000) return giftBox.balances
    const session = await getResetSession()
    if (!giftBox.llm || !session) return null
    if (!force && giftBox.inflight) return giftBox.inflight
    const gen = ++giftBox.balancesGen
    const pending = (async () => {
      try {
        const value = await fetchGiftBalances(session, resetFetch)
        if (gen === giftBox.balancesGen && giftBox.llm) {
          giftBox.balances = value
          rememberGiftExpiry(value)
        }
      } catch (error) {
        if (gen === giftBox.balancesGen && error instanceof ResetAuthError) invalidateResetSession(false)
      } finally {
        if (gen === giftBox.balancesGen) giftBox.balancesAt = Date.now()
        if (giftBox.inflight === pending) giftBox.inflight = null
      }
      return giftBox.balances
    })()
    giftBox.inflight = pending
    return pending
  }

  /** capabilities 是唯一可接受的即时模型 id 来源；show_name 仅是展示文案。 */
  function exactModelIds(capabilities) {
    const ids = (Array.isArray(capabilities) ? capabilities : []).map((value) => {
      const capability = String(value || '').trim()
      return capability.toLowerCase().startsWith('model:') ? capability.slice(6).trim() : ''
    }).filter(Boolean)
    return [...new Set(ids)]
  }

  /**
   * 领取已成功，但 balance 尚未入账时，用投放与 claim 响应合成临时桶。
   * 只合成已生效权益；未来生效或缺少 serverTime 无法判定时不提前发布。
   */
  function syntheticClaimBalances(offer, plan, previous) {
    const raw = plan && plan.raw && typeof plan.raw === 'object' ? plan.raw : {}
    const rawEntitlements = (Array.isArray(raw.entitlements) ? raw.entitlements : []).filter((e) => e && typeof e === 'object')
    const offerEntitlements = offer && Array.isArray(offer.entitlements) ? offer.entitlements : []
    const useRaw = rawEntitlements.length > 0
    const count = useRaw ? rawEntitlements.length : offerEntitlements.length
    const buckets = []
    for (let i = 0; i < count; i++) {
      const rawEntitlement = useRaw ? rawEntitlements[i] : {}
      const rawId = String(rawEntitlement.entitlement_id || '')
      const offerEntitlement = useRaw
        ? (rawId ? offerEntitlements.find((e) => e.id === rawId) : offerEntitlements[i])
        : offerEntitlements[i]

      let effectiveAt = offerEntitlement ? offerEntitlement.effectiveAt : null
      if (Object.hasOwn(rawEntitlement, 'effective_at')) {
        const effectiveSec = Number(rawEntitlement.effective_at)
        effectiveAt = Number.isFinite(effectiveSec) ? (effectiveSec > 0 ? effectiveSec * 1000 : null) : undefined
      }
      if (effectiveAt === undefined) continue
      if (effectiveAt != null && effectiveAt > 0 && (!Number.isFinite(plan.serverTime) || effectiveAt > plan.serverTime)) continue

      const rawModels = exactModelIds(rawEntitlement.capabilities)
      const modelIds = rawModels.length ? rawModels : exactModelIds(offerEntitlement && offerEntitlement.capabilities)
      if (!modelIds.length) continue
      const unitValue = rawEntitlement.grant_units ?? (offerEntitlement && offerEntitlement.units)
      const units = Number(unitValue)
      const total = Number.isFinite(units) ? units : null
      const rawExpiry = rawEntitlement.expires_at ?? raw.ends_at
      const expirySec = Number(rawExpiry)
      const expiresAt = Number.isFinite(expirySec) && expirySec > 0
        ? expirySec * 1000
        : (rawExpiry == null && offer ? offer.endsAt : null)
      for (const model of modelIds) {
        buckets.push({
          planId: plan.planId,
          bucketId: String(rawEntitlement.bucket_id || rawId || (offerEntitlement && offerEntitlement.id) || ('claim-' + i)),
          model,
          unitType: String(rawEntitlement.unit_type || (offerEntitlement && offerEntitlement.unitType) || 'token'),
          total,
          used: 0,
          remaining: total,
          expiresAt,
        })
      }
    }
    if (!buckets.length) return null

    const oldPlans = previous && Array.isArray(previous.plans) ? previous.plans : []
    const oldBuckets = previous && Array.isArray(previous.buckets) ? previous.buckets : []
    const planEndSec = Number(raw.ends_at)
    const syntheticPlan = {
      planId: plan.planId,
      name: plan.name || (offer && offer.name) || '',
      status: 'active',
      endsAt: Number.isFinite(planEndSec) && planEndSec > 0 ? planEndSec * 1000 : (offer ? offer.endsAt : null),
    }
    const bucketKeys = new Set(buckets.map((b) => b.planId + ':' + b.bucketId + ':' + b.model))
    return {
      serverTime: plan.serverTime ?? (previous && previous.serverTime) ?? null,
      plans: [...oldPlans.filter((p) => p.planId !== plan.planId), syntheticPlan],
      buckets: [
        ...oldBuckets.filter((b) => !bucketKeys.has(b.planId + ':' + b.bucketId + ':' + b.model)),
        ...buckets,
      ],
    }
  }

  function warnGiftSync(action, error) {
    const key = action + ':' + safeMsg(error)
    if (giftBox.lastError === key) return
    giftBox.lastError = key
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('[model-usage] GLM 赠送模型' + action + '失败：' + safeMsg(error))
    }
  }

  function disposeGiftAdapter() {
    const disposer = giftBox.disposer
    giftBox.disposer = null
    giftBox.adapter = null
    giftBox.modelSignature = ''
    if (!disposer) return
    try { publishGiftChange(disposer) } catch (error) { warnGiftSync('注销', error) }
  }

  /** 把赠送注册表顺序保持在关联 GLM 之后；真正移动时才通知 GUI 重读目录。 */
  function syncGiftOrder() {
    if (keepGiftAfterGlm(giftBox.llm, giftBox.associatedRoute)) notifyAdaptersUpdated()
  }

  /** 依据模型 id 签名注册、刷新或注销 glm-gift；失败保留可重试状态且不影响额度展示。 */
  async function syncGiftAdapter() {
    if (giftBox.expiryTimer) clearTimeout(giftBox.expiryTimer)
    giftBox.expiryTimer = null
    const models = giftModelsFromBalances(giftBox.balances && giftBox.balances.buckets)
      .map((m) => ({ id: m.id, name: m.id }))
    giftBox.providerName = giftGroupName(giftBox.glmDisplayName)
    // 分组名、模型 id 与关联路由一起构成发布签名：关联 GLM 改名/换账号时也要 replace。
    const signature = JSON.stringify({ models: models.map((m) => m.id).sort(), name: giftBox.providerName, route: giftBox.associatedRoute || '' })
    // 计时只使用已查询/领取成功的截止证据；查询失败或用尽不触发回退。
    const now = Date.now()
    const expiries = [...giftBox.expiryBuckets.values()].map((b) => b.expiresAt).filter((t) => Number.isFinite(t) && t > now)
    if (giftBox.llm && expiries.length) {
      giftBox.expiryTimer = setTimeout(() => { void syncGiftAdapter().catch((error) => warnGiftSync('到期更新', error)) }, Math.min(Math.min(...expiries) - now + 1, 2147483647))
      giftBox.expiryTimer.unref?.()
    }
    const generation = giftBox.balancesGen
    const scope = scopeGeneration
    await giftBox.fallback?.sweep()
    if (generation !== giftBox.balancesGen || scope !== scopeGeneration) return
    if (!models.length || !giftBox.llm) {
      disposeGiftAdapter()
      return
    }
    if (giftBox.disposer) {
      if (giftBox.modelSignature === signature) { syncGiftOrder(); return }
      try {
        // replace 会 commitRoutes 并重新 emit llm/adapters-updated，通知 GUI 重读动态模型目录。
        publishGiftChange(() => giftBox.disposer.replace([GIFT_PROVIDER]))
        giftBox.modelSignature = signature
        giftBox.lastError = ''
        syncGiftOrder()
        return
      } catch (error) {
        warnGiftSync('刷新', error)
        // 句柄可能已随 fiber 释放：清掉旧状态并立即走完整注册；失败则下轮快照继续重试。
        disposeGiftAdapter()
      }
    }
    try {
      const adapter = new GiftModelAdapter({
        getModels: () => giftModelsFromBalances(giftBox.balances && giftBox.balances.buckets).map((m) => ({ id: m.id, name: m.id })),
        providerName: () => giftBox.providerName,
        resolveAuth: async () => {
          const session = await getResetSession()
          if (!session || !session.zcodeJwt) throw new Error('未连接 ZCode 会话')
          // Start Plan 运行时只使用 ZCode JWT；BigModel access_token 不用于该端点。
          return { token: session.zcodeJwt }
        },
      })
      giftBox.disposer = publishGiftChange(() => giftBox.llm.registerAdapter([GIFT_PROVIDER], adapter))
      giftBox.adapter = adapter
      giftBox.modelSignature = signature
      giftBox.lastError = ''
      syncGiftOrder()
    } catch (error) {
      giftBox.disposer = null
      giftBox.modelSignature = ''
      warnGiftSync('注册', error)
    }
  }

  function invalidateGiftBinding() {
    giftBox.bindingGeneration++
    giftBox.bindingStatus = 'unavailable'
    giftBox.associatedRoute = null
    giftBox.glmDisplayName = ''
    accountBinding.invalidate()
  }

  function clearAccountState() {
    invalidateGiftBinding()
    resetBox.status = null
    resetBox.statusAt = 0
    resetBox.nextTryAt = 0
    resetBox.idemKeys = {}
    marketingBox.offers = null
    marketingBox.offersAt = 0
    giftBox.balancesGen++
    giftBox.expiryBuckets.clear()
    if (giftBox.expiryTimer) clearTimeout(giftBox.expiryTimer)
    giftBox.expiryTimer = null
    giftBox.balances = null
    giftBox.balancesAt = 0
    giftBox.inflight = null
    disposeGiftAdapter()
  }

  async function getResetSession() {
    if (resetBox.session !== undefined && Date.now() - resetBox.sessionAt < 60000) return resetBox.session
    if (resetBox.inflight) return resetBox.inflight
    const gen = resetBox.sessionGeneration
    const pending = (async () => {
      const session = await Promise.resolve().then(sessionResolver).catch(() => null)
      if (gen !== resetBox.sessionGeneration) return resetBox.session || null
      const previous = resetBox.session
      if (previous && (previous.zcodeJwt !== session?.zcodeJwt || previous.businessJwt !== session?.businessJwt || previous.businessFamily !== session?.businessFamily)) {
        resetBox.sessionGeneration++
        clearAccountState()
      }
      resetBox.session = session
      resetBox.sessionAt = Date.now()
      return session
    })()
    resetBox.inflight = pending
    try { return await pending } finally {
      if (resetBox.inflight === pending) resetBox.inflight = null
    }
  }

  function invalidateResetSession(clearEmbedded) {
    resetBox.sessionGeneration++
    resetBox.session = undefined
    resetBox.sessionAt = 0
    resetBox.inflight = null
    clearAccountState()
    if (clearEmbedded) clearSession().catch(() => {})
  }

  /** 读取重置机会状态；无会话返回 null；401 失效抛 model-usage/reset-auth。 */
  async function getResetStatus(force) {
    const now = Date.now()
    const session = await getResetSession()
    if (!session?.businessJwt) { resetBox.status = null; resetBox.statusAt = now; return null }
    if (!force && resetBox.status && now - resetBox.statusAt < 300000) return resetBox.status
    const gen = resetBox.sessionGeneration
    try {
      let r
      if (resetBox.nextTryAt && now < resetBox.nextTryAt) {
        r = { status: await fetchResetStatus(session, resetFetch), nextTryAt: resetBox.nextTryAt }
      } else {
        r = await fetchResetStatusWithOpportunity(session, resetFetch)
      }
      if (gen !== resetBox.sessionGeneration) return null
      resetBox.status = r.status
      resetBox.statusAt = Date.now()
      if (r.nextTryAt) resetBox.nextTryAt = Math.max(r.nextTryAt, Date.now() + 5 * 60000)
      return resetBox.status
    } catch (e) {
      if (gen !== resetBox.sessionGeneration) return null
      if (e instanceof ResetAuthError) {
        const wasEmbedded = resetBox.session && resetBox.session.source === 'embedded'
        invalidateResetSession(wasEmbedded)
        const err = new Error('ZCode 会话已失效，请通过 GLM 卡片「账户」重新连接')
        err.code = 'model-usage/reset-auth'
        throw err
      }
      throw e
    }
  }

  /** 读取 profile 里本插件的依赖 spec，判断是否为本地链接/文件安装（这类安装不做自动更新） */
  async function isLocalInstall() {
    const dir = profileDirectory()
    if (!dir) return true // 拿不到 profile 信息时保守处理：只跳转、不自动安装
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const dep = (pkg.dependencies || {})['@antecer/dsh-model-usage']
      return typeof dep === 'string' && /^(link:|file:)/.test(dep)
    } catch {
      return true
    }
  }

  /** 版本检查结果 + 自动更新可用性（本地链接安装不提供一键更新） */
  async function versionCheckResult(force) {
    const r = await versionService.check(force)
    const localInstall = await isLocalInstall()
    return { ...r, localInstall, autoUpdatable: !localInstall && !!r.spec }
  }

  const jsonSafe = (v) => {
    try { return JSON.parse(JSON.stringify(v === undefined ? null : v)) } catch { return null }
  }

  /**
   * 一键更新：插件管理器对已安装包会拒绝直接安装（HMR 下报 already-installed），
   * 官方流程是先移除再安装。因此这里先把「安装新版本」排程到本插件卸载之后执行
   * （定时器属于 Host 进程，不随本插件上下文销毁），再移除自身依赖，由管理器重装。
   */
  async function runUpdate() {
    const pm = ctx.get('pluginManager')
    if (!pm || typeof pm.installBundle !== 'function' || typeof pm.removeBundle !== 'function') {
      return fail('model-usage/no-plugin-manager', '当前 DSH 未提供插件管理器，请到插件页手动更新')
    }
    const r = await versionCheckResult(true)
    if (!r.hasUpdate || !r.spec) return fail('model-usage/no-update', '没有可用的更新版本')
    if (r.localInstall) return fail('model-usage/local-install', '当前为本地链接安装，请到插件页手动更新')
    // 先校验目标 spec 可安装（inspect），尽量降低「卸载后装不回来」的概率
    try {
      const inspected = await pm.inspect(r.spec, {})
      const problem = inspected && (inspected.problem || (inspected.value && inspected.value.problem))
      if (problem) return fail('model-usage/inspect-' + problem, '目标版本不可安装：' + problem)
    } catch { /* inspect 失败不阻断，交给安装阶段报错并记录 */ }
    const spec = r.spec
    const timer = setTimeout(() => {
      pm.installBundle(spec, { enabled: true }).catch(async (e) => {
        try {
          const { homedir } = await import('node:os')
          const { mkdir, appendFile } = await import('node:fs/promises')
          const dir = join(homedir(), '.dsh', 'model-usage')
          await mkdir(dir, { recursive: true })
          await appendFile(join(dir, 'update.log'), new Date().toISOString() + ' ' + spec + '\n' + String((e && e.stack) || e) + '\n')
        } catch { /* 日志失败不抛出 */ }
      })
    }, 1500)
    if (timer.unref) timer.unref()
    const removed = await pm.removeBundle('@antecer/dsh-model-usage')
    return ok({ scheduled: true, spec, removed: jsonSafe(removed) })
  }

  async function handleRpc(endpoint, payload) {
    switch (endpoint) {
      case 'snapshot':
        return ok(await buildSnapshot(!!(payload && payload.refresh), typeof (payload && payload.route) === 'string' ? payload.route : null))
      case 'stats':
        return ok(ledger.stats(payload && typeof payload === 'object' ? payload : {}))
      case 'config':
        return ok({ refreshSeconds: config.refreshSeconds, footer: !!config.footer, card: { template: config.card.template || '' } })
      case 'pricingEnv': {
        const h = await pricingService.getHolidays()
        return ok({
          rules: { peakDays: config.pricing.peakDays, peakWindows: config.pricing.peakWindows },
          holidays: h.days,
          years: h.years,
          error: h.error || null,
        })
      }
      case 'pricingCheck':
        return ok(await pricingService.checkOfficial())
      case 'versionCheck':
        return ok(await versionCheckResult(payload && payload.force === true))
      case 'updatePlugin':
        return await runUpdate()
      case 'current':
        return ok({ route: (state.lastActive && state.lastActive.route) || null })
      case 'zcodeAuthState': {
        const session = await getResetSession()
        return ok({
          connected: !!session,
          source: (session && session.source) || null,
          family: (session && session.businessFamily) || null,
        })
      }
      case 'zcodeLoginStart': {
        const state = newLoginState()
        resetBox.pendingLogin = { state, at: Date.now() }
        return ok({ url: buildAuthorizeUrl(state), state })
      }
      case 'zcodeLoginComplete': {
        const parsed = parseCallbackInput(payload && payload.input)
        if (!parsed) return fail('model-usage/bad-callback', '无法从粘贴内容中解析授权码，请复制完整的 zcode:// 回调链接')
        const pending = resetBox.pendingLogin
        const state = parsed.state || (pending && pending.state)
        if (!state) return fail('model-usage/login-expired', '登录会话已过期，请重新点击「去授权」')
        if (parsed.state && pending && parsed.state !== pending.state) {
          return fail('model-usage/state-mismatch', '回调链接与本次登录不匹配，请使用最近一次「去授权」打开的页面')
        }
        const session = await exchangeCode({ code: parsed.code, state }, resetFetch)
        await saveSession(session)
        resetBox.pendingLogin = null
        invalidateResetSession(false)
        return ok({ connected: true })
      }
      case 'zcodeDisconnect': {
        await clearSession()
        invalidateResetSession(false)
        resetBox.session = null
        resetBox.sessionAt = Date.now()
        return ok({ connected: false })
      }
      case 'resetUse': {
        const type = payload && payload.type === 'WEEK' ? 'WEEK' : 'FIVE_HOUR'
        const session = await getResetSession()
        if (!session?.businessJwt) return fail('model-usage/reset-auth', '未连接有效的业务账户，请先在 GLM 卡片「账户」中连接')
        const key = resetBox.idemKeys[type] || (resetBox.idemKeys[type] = (await import('node:crypto')).randomUUID())
        await useReset(session, type, key, resetFetch)
        delete resetBox.idemKeys[type] // 成功清除；失败保留供重试复用
        // 核销成功：额度缓存作废（下轮快照强制重查），重置状态强制对账
        for (const [route, c] of state.cache) {
          if (c && c.data && c.data.adapter === 'glm-coding') state.cache.delete(route)
        }
        resetBox.statusAt = 0
        const status = await getResetStatus(true)
        return ok({ status })
      }
      case 'claimOffer': {
        const planId = payload && typeof payload.planId === 'string' ? payload.planId.trim() : ''
        const campaignId = payload && typeof payload.campaignId === 'string' ? payload.campaignId.trim() : ''
        if (!planId) return fail('model-usage/bad-request', '缺少 planId')
        const session = await getResetSession()
        if (!session) return fail('model-usage/reset-auth', '未连接 ZCode 会话，请先在 GLM 卡片「账户」中连接')
        const matchedOffer = (marketingBox.offers || []).find((offer) =>
          offer.planId === planId && (!campaignId || offer.campaignId === campaignId))
        const claimGeneration = resetBox.sessionGeneration
        const claimScope = scopeGeneration
        let plan
        try {
          plan = await claimPlan(session, planId, resetFetch)
        } catch (e) {
          if (e instanceof ResetAuthError) return fail('model-usage/reset-auth', 'ZCode 会话已失效，请通过 GLM 卡片「账户」重新连接')
          // 与 ZCode execute 对齐：业务失败保留服务端 data.message；
          // 1001-1005 为终止型失败，提交后网络/解析异常视为结果不确定。
          if (e && Number.isFinite(Number(e.bizCode))) {
            return ok({
              status: 'failure',
              terminal: [1001, 1002, 1003, 1004, 1005].includes(Number(e.bizCode)),
              message: safeMsg(e),
            })
          }
          return ok({ status: 'uncertain' })
        }
        if (claimGeneration !== resetBox.sessionGeneration || claimScope !== scopeGeneration) return ok({ status: 'success', plan })
        // 已确认领取且权益已生效：先本地合成桶并同步候选，任何 balance 网络查询都不得阻塞成功返回。
        const synthetic = syntheticClaimBalances(matchedOffer, plan, giftBox.balances)
        if (synthetic) {
          giftBox.balancesGen++ // 使 claim 前已在途的旧 balance 响应失效
          giftBox.balances = synthetic
          rememberGiftExpiry(synthetic)
          await syncGiftAdapter().catch(() => {})
        }
        // 领取成功：交互上报（best-effort）+ GLM 额度缓存作废（Start Plan 桶即将出现在 balance）+ 投放缓存失效
        if (campaignId) reportTouchAction(session, campaignId, 'confirm', resetFetch).catch(() => {})
        for (const [route, c] of state.cache) {
          if (c && c.data && c.data.adapter === 'glm-coding') state.cache.delete(route)
        }
        resetBox.statusAt = 0
        marketingBox.offers = null
        marketingBox.offersAt = 0
        // 成功结果不等待网络；后台强制 balance 对账并有界重试，最终仍以服务端白名单为准。
        giftBox.balancesAt = 0
        void (async () => {
          for (const delayMs of [0, 250, 1000]) {
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
            if (claimGeneration !== resetBox.sessionGeneration || claimScope !== scopeGeneration) return
            await getGiftBalances(true).catch(() => {})
            await syncGiftAdapter().catch(() => {})
            // 只认本次 plan 的可执行桶；账号已有其他赠额不能误判为本次已入账。
            const targetModels = giftModelsFromBalances(
              (giftBox.balances && Array.isArray(giftBox.balances.buckets) ? giftBox.balances.buckets : [])
                .filter((bucket) => bucket.planId === plan.planId),
            )
            if (targetModels.length) return
          }
        })()
        return ok({ status: 'success', plan })
      }
      default:
        return fail('model-usage/unknown-endpoint', 'unknown endpoint: ' + String(endpoint))
    }
  }

  // ---- 账本：加载 + 卸载时落盘
  ctx.effect(() => {
    ledger.ready().catch(() => {})
    return () => ledger.flush().catch(() => {})
  }, 'model-usage: ledger')

  // ---- 官方价格校验：启动后预热一次，之后每 12h 一次（失败静默，不影响任何 RPC）
  // 定时器 unref：不阻止宿主/测试进程退出（与 ledger ticker 同款处理）
  ctx.effect(() => {
    const warm = setTimeout(() => { pricingService.checkOfficial().catch(() => {}) }, 15000)
    const timer = setInterval(() => { pricingService.checkOfficial().catch(() => {}) }, 12 * 3600 * 1000)
    if (warm && warm.unref) warm.unref()
    if (timer && timer.unref) timer.unref()
    return () => { clearTimeout(warm); clearInterval(timer) }
  }, 'model-usage: pricing check')

  // ---- 会话事件：记账 + 模型调用后尽快刷新对应额度
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d) return
      if (type === 'request/context' && d.provider) {
        state.lastActive = { route: d.provider, ts: Date.now() }
        return
      }
      if (type === 'assistant/message' && d.message && d.message.source && d.message.source.provider) {
        const prov = d.message.source.provider
        state.lastActive = { route: prov, ts: Date.now() }
        const u = d.usage
        if (u && typeof u === 'object') {
          try {
            // 会话 id 用于按对话聚合：形态防御（string/key/id/getSnapshot）
            const sid = (() => {
              try {
                if (!session) return null
                if (typeof session === 'string') return session
                if (session.key || session.id) return session.key || session.id
                if (typeof session.getSnapshot === 'function') {
                  const v = session.getSnapshot()
                  return (v && (v.key || v.id)) || null
                }
              } catch { /* 忽略 */ }
              return null
            })()
            ledger.record({ time: (event && event.time) || Date.now(), provider: prov, model: d.message.source.model || '', usage: u, session: sid })
          } catch { /* 记账失败不影响主流程 */ }
        }
        if (prov === GIFT_PROVIDER) giftBox.balancesAt = 0
        const c = state.cache.get(prov)
        if (c && Date.now() - c.at > 15000 && !c.inflight) {
          resolveAdapter(prov).then((ad) => { if (ad) getUsage(ad, prov, true).catch(() => {}) }).catch(() => {})
        }
      }
    } catch { /* 事件处理永不向上抛 */ }
  }), 'model-usage: session events')

  // ---- 额度面（需要 llm + credentials）
  ctx.inject(['llm', 'credentials'], (scope) => {
    quotaScope = scope
    scopeGeneration++
    giftBox.llm = scope.llm || null // 同一运行树内的 llm 服务实例（registerAdapter 用）
    // 到期回退独立依赖会话服务；服务缺失或晚加载不能使整个额度查询作用域初始化失败。
    scope.inject(['agents', 'sessionController'], (fallbackScope) => {
      fallbackScope.effect(() => {
        const fallback = createGiftFallback(fallbackScope, {
          getState: () => giftBox.llm && resetBox.session?.zcodeJwt && giftBox.associatedRoute
            ? { parentRoute: giftBox.associatedRoute, buckets: [...giftBox.expiryBuckets.values()] }
            : null,
        })
        giftBox.fallback = fallback
        return () => {
          fallback.dispose()
          if (giftBox.fallback === fallback) giftBox.fallback = null
        }
      }, 'model-usage: gift expiry fallback')
    })
    scope.effect(() => scope.on('llm/adapters-updated', () => {
      if (publishingGift) return
      // 供应商变更：代际 +1 丢弃在途结果，清空缓存、探测结论与 profile 快照
      invalidateGiftBinding()
      state.generation++
      state.cache.clear()
      state.probe.clear()
      state.probeInfo.clear()
      state.profile = null
      import('./profile.mjs').then((m) => m.invalidateProfileCache()).catch(() => {})
    }), 'model-usage: adapters-updated')
    scope.effect(() => scope.on('credentials/reference-updated', () => {
      invalidateGiftBinding()
      state.generation++
      state.cache.clear()
    }), 'model-usage: credentials-updated')
    scope.effect(() => () => {
      // 注入作用域销毁：代际 +1 使在途结果失效
      state.generation++
      quotaScope = null
      scopeGeneration++
      giftBox.llm = null
      invalidateResetSession(false)
    }, 'model-usage: quota teardown')
  })

  // ---- 前端路由（connection.admit 认证围栏 + webServer 注册）
  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/model-usage',
      handler: async (req, res) => {
        const admission = scope.connection.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          if (req.method === 'GET') {
            const pn = (req.url || '').split('?')[0]
            // 插件样式：GET /model-usage/style.css
            if (pn === '/model-usage/style.css') {
              try {
                const css = await readFile(STYLE_FILE, 'utf8')
                res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(css)
              } catch { res.writeHead(404); res.end() }
              return
            }
            // 供应商图标：GET /model-usage/icons/<slug>.svg（slug 白名单字符）
            const m = /^\/model-usage\/icons\/([a-z0-9][a-z0-9_-]{0,39})\.svg$/.exec(pn)
            if (m) {
              try {
                const svg = await readFile(join(ICONS_DIR, m[1] + '.svg'), 'utf8')
                res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
                res.end(svg)
              } catch { res.writeHead(404); res.end() }
              return
            }
            res.writeHead(404); res.end()
            return
          }
          if (req.method !== 'POST') {
            json(405, fail('model-usage/method', 'POST only'))
            return
          }
          const body = await readBody(req, 1 << 20)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { json(400, fail('model-usage/bad-request', 'body is not JSON')); return }
          json(200, await handleRpc(String(parsed.endpoint || ''), parsed.payload))
        } catch (e) {
          json(200, fail('model-usage/internal', safeMsg(e)))
        }
      },
    }), 'model-usage: route')
  })
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
