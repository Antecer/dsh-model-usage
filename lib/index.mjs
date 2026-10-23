// dsh-model-usage · Host 半区
// 职责：Cordis 插件入口、/model-usage 前缀路由（connection.admit 认证围栏）、
// 额度快照编排（并行取数/缓存/单飞/退避/代际失效、统一 fetchedAt、窗口排序）、
// 本机用量统计输出（ledger：今日/本周/本月/全部摘要、364 天热力图、按会话/按日聚合）、
// GLM 额度重置编排（ZCode 共享会话、机会状态缓存与冷却、核销幂等）、sub2api 探测。
import { adapterFor, resolveSub2api, safeMsg } from './adapters.mjs'
import { createLedger } from './ledger.mjs'
import { resolveSession, clearSession, saveSession } from './zcode/auth.mjs'
import { fetchResetStatus, fetchResetStatusWithOpportunity, useReset, ResetAuthError } from './zcode/reset.mjs'
import { newLoginState, buildAuthorizeUrl, parseCallbackInput, exchangeCode } from './zcode/login.mjs'
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
}

export const name = '@antecer/dsh-model-usage'

const prettyNames = {
  'deepseek-official': 'DeepSeek',
  'deepseek-account': 'DeepSeek 账号',
  'zai-coding-cn': 'GLM Coding Plan',
  zai: 'GLM Coding (国际)',
}

export function apply(ctx, rawConfig) {
  const raw = rawConfig || {}
  const config = { ...DEFAULTS, ...raw }
  for (const k of ['credentials', 'adapters', 'glm', 'sub2api', 'card']) config[k] = { ...(raw[k] || {}) }
  config.refreshSeconds = Math.max(1, Number(config.refreshSeconds) || 60)

  const ok = (value) => ({ ok: true, value })
  const fail = (code, message) => ({ ok: false, error: { code, message: safeMsg(message) } })

  const state = {
    cache: new Map(),        // route -> { inflight, at, backoffUntil, backoff, data, gen }
    probe: new Map(),        // route -> 'sub2api' | 'none'（探测结论缓存）
    probeInfo: new Map(),    // route -> { baseURL, apiKeyEnv }
    profile: null,           // profile 供应商表（{ route: { baseURL, apiKeyEnv, displayName } }）
    generation: 0,           // 配置/供应商变更代际：旧代际的在途结果被丢弃
    lastActive: null,        // { route, ts } 最近一次真实模型调用
  }
  let quotaScope = null
  const ledger = createLedger()

  const getAccount = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch { return null }
  }

  /** 读取 profile 供应商表（profile.js 自带 60s 缓存；配置变更时随代际清空）。routes 用于无环境变量时识别当前 profile。 */
  async function ensureProfile(routes) {
    if (!state.profile) {
      try {
        const { profileProviders } = await import('./profile.mjs')
        state.profile = await profileProviders(routes)
      } catch { state.profile = {} }
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
    push(config.credentials[route])
    const providerKey = probe.apiKeyEnv || prof.apiKeyEnv
    if (providerKey) {
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
    if (!force && c.data && now - c.at < config.refreshSeconds * 1000) return c.data
    if (!force && now < c.backoffUntil && c.data) return { ...c.data, status: 'stale', stale: true }

    const gen = state.generation
    const p = (async () => {
      try {
        const d = await ad.read(await makeEnv(ad, route))
        if (gen !== state.generation) return c.data // 代际已变：丢弃过期在途结果
        d.route = route
        d.adapter = ad.id
        d.fetchedAt = d.fetchedAt || Date.now()
        c.data = d
        c.at = Date.now()
        c.backoffUntil = 0
        c.backoff = 0
      } catch (e) {
        if (gen !== state.generation) return c.data
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
      return c.data
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

    // 并行取数：串行会让先完成的供应商等到最慢的一个，卡片「刚刷新就显示十几秒前」
    const startedAt = Date.now()
    const results = await Promise.all(routes.map(async (r) => {
      const base = { route: r.id, displayName: prettyName(r, profile) }
      const ad = await resolveAdapter(r.id)
      if (!ad) return null // 无额度接口的供应商不显示
      const usage = await getUsage(ad, r.id, force && (route === null || route === r.id))
      return usage ? { ...base, ...usage } : null
    }))
    // 本轮新取到的数据统一标记为快照完成时刻：数据是随响应一起到达用户眼前的，
    // 卡片应从「1s」起计数；同时写回缓存，避免后续 TTL 命中的交付让时钟回退
    const doneAt = Date.now()
    const providers = []
    for (const p of results) {
      if (!p) continue
      p.windows = sortWindows(p.windows)
      if (p.fetchedAt && p.fetchedAt >= startedAt) {
        p.fetchedAt = doneAt
        const c = state.cache.get(p.route)
        if (c && c.data && c.data.fetchedAt && c.data.fetchedAt >= startedAt) c.data.fetchedAt = doneAt
      }
      providers.push(p)
    }
    // GLM 重置机会仅在有 GLM 卡片时拉取（账号级状态，失败不影响快照）
    if (providers.some((p) => p.adapter === 'glm-coding')) {
      const resetStatus = await getResetStatus().catch(() => undefined)
      const resetSession = await getResetSession().catch(() => null)
      for (const p of providers) {
        if (p.adapter !== 'glm-coding') continue
        p.zcodeConnected = !!(resetSession || resetStatus)
        if (resetStatus) p.resets = resetStatus
      }
    }
    return {
      generatedAt: doneAt,
      refreshSeconds: config.refreshSeconds,
      card: { template: typeof config.card.template === 'string' ? config.card.template : '' },
      providers,
    }
  }

  // ---- GLM 额度重置（仅 GLM 卡片；会话复用 ZCode 应用 > 内嵌登录）
  // 测试接缝：config.sessionResolver / config.resetFetch 可注入替身
  const sessionResolver = config.sessionResolver || resolveSession
  const resetFetch = config.resetFetch || fetch
  const resetBox = {
    session: undefined, sessionAt: 0,   // undefined = 未探测
    status: null, statusAt: 0,          // 重置机会状态缓存（5 分钟 TTL）
    nextTryAt: 0,                       // opportunity 限流冷却（服务端 next_try_at）
    pendingLogin: null,                 // 内嵌登录的待发 state
    idemKeys: {},                       // type -> 幂等 key（失败重试复用，成功清除）
  }

  async function getResetSession() {
    if (resetBox.session !== undefined && Date.now() - resetBox.sessionAt < 60000) return resetBox.session
    resetBox.session = await sessionResolver().catch(() => null)
    resetBox.sessionAt = Date.now()
    return resetBox.session
  }

  function invalidateResetSession(clearEmbedded) {
    resetBox.session = undefined
    resetBox.status = null
    resetBox.statusAt = 0
    if (clearEmbedded) clearSession().catch(() => {})
  }

  /** 读取重置机会状态；无会话返回 null；401 失效抛 model-usage/reset-auth。 */
  async function getResetStatus(force) {
    const now = Date.now()
    if (!force && resetBox.status && now - resetBox.statusAt < 300000) return resetBox.status
    const session = await getResetSession()
    if (!session) { resetBox.status = null; resetBox.statusAt = now; return null }
    try {
      let r
      if (resetBox.nextTryAt && now < resetBox.nextTryAt) {
        r = { status: await fetchResetStatus(session, resetFetch), nextTryAt: resetBox.nextTryAt }
      } else {
        r = await fetchResetStatusWithOpportunity(session, resetFetch)
      }
      resetBox.status = r.status
      resetBox.statusAt = Date.now()
      if (r.nextTryAt) resetBox.nextTryAt = Math.max(r.nextTryAt, Date.now() + 5 * 60000)
      return resetBox.status
    } catch (e) {
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

  async function handleRpc(endpoint, payload) {
    switch (endpoint) {
      case 'snapshot':
        return ok(await buildSnapshot(!!(payload && payload.refresh), typeof (payload && payload.route) === 'string' ? payload.route : null))
      case 'stats':
        return ok(ledger.stats(payload && typeof payload === 'object' ? payload : {}))
      case 'config':
        return ok({ refreshSeconds: config.refreshSeconds, footer: !!config.footer, card: { template: config.card.template || '' } })
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
        resetBox.session = undefined
        resetBox.statusAt = 0
        return ok({ connected: true })
      }
      case 'zcodeDisconnect': {
        await clearSession()
        resetBox.session = undefined
        resetBox.status = null
        resetBox.statusAt = 0
        return ok({ connected: false })
      }
      case 'resetUse': {
        const type = payload && payload.type === 'WEEK' ? 'WEEK' : 'FIVE_HOUR'
        const session = await getResetSession()
        if (!session) return fail('model-usage/reset-auth', '未连接 ZCode 会话，请先在 GLM 卡片「账户」中连接')
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
      default:
        return fail('model-usage/unknown-endpoint', 'unknown endpoint: ' + String(endpoint))
    }
  }

  // ---- 账本：加载 + 卸载时落盘
  ctx.effect(() => {
    ledger.ready().catch(() => {})
    return () => ledger.flush().catch(() => {})
  }, 'model-usage: ledger')

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
    scope.effect(() => scope.on('llm/adapters-updated', () => {
      // 供应商变更：代际 +1 丢弃在途结果，清空缓存、探测结论与 profile 快照
      state.generation++
      state.cache.clear()
      state.probe.clear()
      state.probeInfo.clear()
      state.profile = null
      import('./profile.mjs').then((m) => m.invalidateProfileCache()).catch(() => {})
    }), 'model-usage: adapters-updated')
    scope.effect(() => () => {
      // 注入作用域销毁：代际 +1 使在途结果失效
      state.generation++
      quotaScope = null
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
