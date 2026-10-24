// @antecer/dsh-model-usage · Client 半区（手写 ModuleLoader bundle）
// 布局：侧栏底部供应商信息卡（跟随当前前台对话供应商，新会话立即跟随 DSH 默认模型）→
// 点击打开双列遮罩弹窗（左：供应商卡片列表，与侧栏同一组件；右：顶部固定摘要
// 今日/本周/本月/全部 + 近 12 个月热力图，下半为会话/模型/渠道/历史四个折叠统计分区，
// 统一信息列「调用次数/输入 tokens/缓存 tokens/输出 tokens」，UI 偏好 localStorage 持久化）。
// GLM 卡片左上角 Logo 为账户入口（ZCode 共享会话），窗口行「重置 N」打开可重置额度弹窗。
// 美术：只用 --dsw-* 主题 token；控件自绘（第三方插件不依赖 ui-primitives 内部 API）。
// 文案：zh/en 双字典，经 slot 的 props.t 翻译。
window.__ModuleLoader__.load({
  id: '@antecer/dsh-model-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const NS = 'dsh-model-usage'
    const REPO_URL = 'https://github.com/Antecer/dsh-model-usage'

    // ---------------------------------------------------------------- i18n
    const zh = {
      nav: '模型用量', refresh: '刷新', close: '关闭', retry: '重试',
      recent: '最近请求', noData: '暂无数据', loading: '加载中…',
      needsCred: '未配置凭据', needsSignin: '未登录', unsupported: '无额度接口',
      stale: '已过期', total: '总余额', granted: '赠金', toppedUp: '充值',
      resetIn: '{t}后重置', expiresIn: '{d} 天后到期', expired: '已到期', invalid: 'Key 已失效', usedUp: '已用',
      leftCompact: '{n}',
      windowDaily: '日', windowWeekly: '周', windowMonthly: '月', windowRolling: '5h', of: '/',
      tabToday: '今日', tabWeek: '本周', tabMonth: '本月', tabAll: '全部', thModel: '模型',
      refreshAll: '全部刷新', thProvider: '供应商',
      sumToday: '今日', sumWeek: '本周', sumMonth: '本月', sumTotal: '全部',
      secModels: '模型统计', secChannels: '渠道统计', secGlobal: '历史统计',
      secConversations: '会话统计', thDate: '日期',
      thCalls: '调用次数', thInput: '输入 tokens', thCache: '缓存 tokens', thOutput: '输出 tokens',
      thConversation: '会话',
      callsIn: '调用 {r} 次 · 输入 {i}', cacheOut: '缓存 {c} · 输出 {o}', winIdle: '调用后开始计时',
      account: '账户', resetAction: '重置', cancel: '取消',
      resetQuotaTitle: '可重置额度', fiveHourReset: '5 小时额度重置', weekReset: '周额度重置',
      chancesPill: '{n} 次', fastestExpire: '最快 {t} 后过期', noChances: '暂无可重置机会',
      resetting: '重置中…', resetOk: '已重置',
      connectZcode: '连接 ZCode 账号', notConnected: '未连接', disconnect: '断开连接',
      srcZcodeApp: '已连接（与 ZCode 应用共用会话）', srcEmbedded: '插件登录',
      sharedNote: '断开将同时退出 ZCode 应用的登录。',
      loginGuide: '浏览器完成 GLM 账号授权后，页面会跳转 zcode:// 链接（可能唤起 ZCode 应用）。请复制地址栏中的完整回调链接粘贴到下方：',
      loginGo: '去授权', loginDone: '完成连接',
      peakTipPeak: '当前时段：梁文峰',
      peakTipValley: '当前时段：梁文谷',
      pricingDriftTitle: '官方价格表已变动',
      pricingDriftBody: '检测到 DeepSeek 官方定价页与本地配置不一致，请按下列差异修改 cordis.patch.yml 中 model-usage 的 pricing 配置（修改后重启本插件生效）。',
      pricingDriftField: '配置项', pricingDriftConfig: '当前配置', pricingDriftOfficial: '官方',
      pricingDriftChecked: '检查时间', pricingDriftGotIt: '知道了',
      lang: 'zh',
    }
    const en = {
      nav: 'Model usage', refresh: 'Refresh', close: 'Close', retry: 'Retry',
      recent: 'Recent requests', noData: 'No data', loading: 'Loading…',
      needsCred: 'Credential missing', needsSignin: 'Not signed in', unsupported: 'No quota API',
      stale: 'Stale', total: 'Total', granted: 'Granted', toppedUp: 'Topped up',
      resetIn: 'resets in {t}', expiresIn: 'expires in {d}d', expired: 'Expired', invalid: 'Key invalid', usedUp: 'Used',
      leftCompact: '{n}',
      windowDaily: 'Daily', windowWeekly: 'Weekly', windowMonthly: 'Monthly', windowRolling: '5h', of: '/',
      tabToday: 'Today', tabWeek: 'This week', tabMonth: 'This month', tabAll: 'All', thModel: 'Model',
      refreshAll: 'Refresh all', thProvider: 'Provider',
      sumToday: 'Today', sumWeek: 'This week', sumMonth: 'This month', sumTotal: 'All',
      secModels: 'Models', secChannels: 'Channels', secGlobal: 'History',
      secConversations: 'Sessions', thDate: 'Date',
      thCalls: 'Calls', thInput: 'In tokens', thCache: 'Cache tokens', thOutput: 'Out tokens',
      thConversation: 'Session',
      callsIn: '{r} calls · in {i}', cacheOut: 'cache {c} · out {o}', winIdle: 'starts on first call',
      account: 'Account', resetAction: 'Reset', cancel: 'Cancel',
      resetQuotaTitle: 'Resettable quota', fiveHourReset: '5-hour quota reset', weekReset: 'Weekly quota reset',
      chancesPill: '{n}', fastestExpire: 'expires in {t}', noChances: 'No reset opportunities',
      resetting: 'Resetting…', resetOk: 'Reset',
      connectZcode: 'Connect ZCode account', notConnected: 'Not connected', disconnect: 'Disconnect',
      srcZcodeApp: 'Connected (session shared with ZCode app)', srcEmbedded: 'Plugin login',
      sharedNote: 'Disconnecting also signs the ZCode app out.',
      loginGuide: 'After authorizing in the browser, the page redirects to a zcode:// link (may open the ZCode app). Copy the full callback URL and paste it below:',
      loginGo: 'Authorize', loginDone: 'Finish',
      peakTipPeak: 'Current period: peak',
      peakTipValley: 'Current period: off-peak',
      pricingDriftTitle: 'Official pricing changed',
      pricingDriftBody: 'The official DeepSeek pricing page no longer matches your config. Update the model-usage "pricing" block in cordis.patch.yml (restart the plugin afterwards).',
      pricingDriftField: 'Field', pricingDriftConfig: 'Current', pricingDriftOfficial: 'Official',
      pricingDriftChecked: 'Checked', pricingDriftGotIt: 'Got it',
      lang: 'en',
    }
    // 语言由框架 slot 的 props.t 提供；字典兜底翻译
    const trWith = (t) => (key, vars) => {
      let out = typeof t === 'function' ? t(key, vars) : null
      if (out == null || out === key) {
        const d = zh[key] != null ? zh : en
        out = d[key] != null ? d[key] : (en[key] != null ? en[key] : key)
        if (vars) for (const k of Object.keys(vars)) out = out.split('{' + k + '}').join(String(vars[k]))
      }
      return out
    }

    // ---------------------------------------------------------------- 格式化
    const curSym = (cur) => (cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : cur ? cur + ' ' : '')
    function fmtNum(n, tr) {
      if (!Number.isFinite(n)) return '0'
      const enMode = tr && tr('lang') === 'en'
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e4 && !enMode) return (n / 1e4).toFixed(1) + ' 万'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(Math.round(n))
    }
    function fmtMoney(v, unit) {
      const n = Number(v)
      if (!Number.isFinite(n)) return ''
      return curSym(unit) + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2))
    }
    function fmtReset(resetAt, tr) {
      if (!resetAt) return ''
      const d = resetAt - Date.now()
      if (d <= 0) return ''
      const days = Math.floor(d / 86400000)
      const hh = Math.floor((d % 86400000) / 3600000)
      const mm = Math.floor((d % 3600000) / 60000)
      const zhMode = tr('lang') === 'zh'
      if (days > 0) return zhMode ? days + ' 天 ' + hh + ' 小时' : days + 'd ' + hh + 'h'
      if (hh > 0) return zhMode ? hh + ' 小时 ' + mm + ' 分钟' : hh + 'h ' + mm + 'm'
      return zhMode ? Math.max(1, mm) + ' 分钟' : Math.max(1, mm) + 'm'
    }
    function relTime(ts) {
      if (!ts) return ''
      const s = Math.floor((Date.now() - ts) / 1000)
      if (s < 1) return '' // 不足 1 秒不显示（而非强制显示 1s 持续两秒）
      if (s < 60) return s + 's'
      if (s < 3600) return Math.floor(s / 60) + 'm'
      return Math.floor(s / 3600) + 'h'
    }

    // ---------------------------------------------------------------- 模板字符串
    // 供应商字段 → 模板变量；默认布局优先剩余额度，无剩余数据退化到余额
    function providerVars(p, tr) {
      const vars = { name: p.displayName || p.route, route: p.route, plan: p.plan || '' }
      if (p.quota && p.quota.remaining != null) {
        vars.remaining = fmtMoney(p.quota.remaining, p.quota.unit)
        vars.limit = p.quota.limit != null ? fmtMoney(p.quota.limit, p.quota.unit) : ''
        vars.used = p.quota.used != null ? fmtMoney(p.quota.used, p.quota.unit) : ''
        if (p.quota.limit > 0) vars.usedPct = Math.round((p.quota.used / p.quota.limit) * 100) + '%'
      }
      if (p.windows && p.windows.length) {
        const top = p.windows.slice().sort((a, b) => (b.usedPct || 0) - (a.usedPct || 0))[0]
        vars.window = top.label || top.key
        vars.leftPct = (100 - Math.round(top.usedPct || 0)) + '%'
        vars.resetIn = fmtReset(top.resetAt, tr)
        if (top.countBased && top.remaining != null) vars.remaining = String(top.remaining) + (top.limit != null ? tr('of') + top.limit : '')
      }
      if (p.balance) {
        vars.balance = curSym(p.balance.currency) + p.balance.total
        vars.currency = p.balance.currency || ''
      }
      return vars
    }
    function renderTemplate(tpl, vars) {
      return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : '')).replace(/\s{2,}/g, ' ').trim()
    }

    // ---------------------------------------------------------------- 图标
    const ICON_MAP = [
      [/^deepseek/, 'deepseek'], [/^(zai|glm|bigmodel|zhipu|chatglm)/, 'zhipu'],
      [/^(moonshot|kimi)/, 'kimi'], [/^openrouter/, 'openrouter'], [/^minimax/, 'minimax'],
      [/^opencode/, 'opencode-logo-light'], [/^(xiaomi|mimo)/, 'xiaomimimo'],
      [/^github-copilot/, 'githubcopilot'], [/^openai/, 'openai'], [/^(anthropic|claude)/, 'anthropic'],
      [/^(google|gemini|vertex)/, 'gemini'], [/^(xai|grok)/, 'xai'], [/^(qwen|bailian|dashscope)/, 'qwen'],
      [/^siliconflow/, 'siliconflow'], [/^ollama/, 'ollama'], [/^(doubao|bytedance|huoshan)/, 'doubao'],
      [/^azure/, 'azure'], [/^(aws|bedrock)/, 'aws'], [/^mistral/, 'mistral'], [/^groq/, 'grok'],
    ]
    function iconSlug(p) {
      if (p.adapter === 'sub2api') return 'sub2api'
      const route = p.route || ''
      for (const [re, slug] of ICON_MAP) if (re.test(route)) return slug
      return null
    }
    function Logo({ p, size = 22 }) {
      const [failed, setFailed] = useState(false)
      const slug = iconSlug(p)
      if (slug && !failed) {
        return h('span', { className: 'dmu-logo', style: { width: size, height: size } },
          h('img', { src: 'model-usage/icons/' + slug + '.svg', alt: '', width: size - 4, height: size - 4, onError: () => setFailed(true) }))
      }
      const ch = String((p && (p.displayName || p.route)) || '?').trim().charAt(0).toUpperCase() || '?'
      return h('span', { className: 'dmu-logo dmu-logo-fallback', style: { width: size, height: size, fontSize: Math.round(size * 0.5) } }, ch)
    }

    // ---------------------------------------------------------------- 状态
    function stateOf(p) {
      if (!p || p.status === 'idle') return 'idle'
      if (p.status === 'error') return 'error'
      if (p.valid === false) return 'error'
      const ws = p.windows || []
      if (ws.length) {
        const max = Math.max.apply(null, ws.map((w) => w.usedPct || 0))
        return max >= 80 ? 'error' : max >= 50 ? 'warn' : 'ok'
      }
      if (p.quota && p.quota.limit > 0) {
        const pct = (p.quota.used / p.quota.limit) * 100
        return pct >= 80 ? 'error' : pct >= 50 ? 'warn' : 'ok'
      }
      if (p.balance) return p.balance.available === false ? 'error' : 'ok'
      return 'idle'
    }
    const Dot = ({ state }) => h('span', { className: 'dmu-dot dmu-dot-' + state })

    // ---------------------------------------------------------------- API
    function createApi() {
      const call = async (endpoint, payload) => {
        const res = await fetch('model-usage/' + endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload || {} }),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const r = await res.json()
        if (r && r.ok) return r.value
        throw new Error((r && r.error && r.error.message) || 'rpc failed')
      }
      return {
        snapshot: (opts) => call('snapshot', opts),
        stats: (opts) => call('stats', opts),
        current: () => call('current'),
        resetUse: (type) => call('resetUse', { type }),
        zcodeAuthState: () => call('zcodeAuthState'),
        zcodeLoginStart: () => call('zcodeLoginStart'),
        zcodeLoginComplete: (input) => call('zcodeLoginComplete', { input }),
        zcodeDisconnect: () => call('zcodeDisconnect'),
        pricingEnv: () => call('pricingEnv'),
        pricingCheck: () => call('pricingCheck'),
      }
    }

    // ---------------------------------------------------------------- 峰谷时段
    // DeepSeek 官方计费（北京时间）：周一至周五 9:00-12:00、14:00-18:00 为高峰，
    // 其余时段（含周末与中国法定节假日全天）为空闲；空闲单价 = 高峰单价的一半。
    // 规则可由 Host 配置覆盖（pricing.peakDays / peakWindows）；节假日表由 Host 经
    // timor.tech 免费接口下发。本函数即唯一实现（test/client-render.test.js 直接抽取回归）。
    const BJ_OFFSET = 8 * 3600e3 // 北京时间无夏令时，固定 UTC+8
    const DEFAULT_PEAK_DAYS = [1, 2, 3, 4, 5]
    const DEFAULT_PEAK_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']]
    function parseHM(s) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim())
      return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
    }
    /** 北京时间字段：把 UTC+8 当 UTC 读，避免依赖浏览器本地时区。 */
    function bjParts(ts) {
      const d = new Date(ts + BJ_OFFSET)
      return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(),
        wd: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
      }
    }
    const bjDateKey = (p) => p.y + '-' + String(p.mo).padStart(2, '0') + '-' + String(p.day).padStart(2, '0')
    /** 北京时区某日某分钟对应的时间戳。 */
    const bjTs = (p, minute) => Date.UTC(p.y, p.mo - 1, p.day, Math.floor(minute / 60) - 8, minute % 60)
    /**
     * 当前峰谷状态：{ peak, changeAt }（changeAt = 下一次切换的时刻）。
     * 峰中返回峰结束；谷中返回下一个峰起点（今天剩余窗口 → 之后首个非节假日工作日）。
     */
    function peakInfo(now, rules, holidaySet) {
      const days = rules && Array.isArray(rules.peakDays) && rules.peakDays.length ? rules.peakDays : DEFAULT_PEAK_DAYS
      const windows = ((rules && Array.isArray(rules.peakWindows)) ? rules.peakWindows : DEFAULT_PEAK_WINDOWS)
        .map((w) => [parseHM(w && w[0]), parseHM(w && w[1])])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      const set = holidaySet || new Set()
      const p = bjParts(now)
      if (days.includes(p.wd) && !set.has(bjDateKey(p))) {
        for (const [a, b] of windows) {
          if (p.minute >= a && p.minute < b) return { peak: true, changeAt: bjTs(p, b) }
          if (p.minute < a) return { peak: false, changeAt: bjTs(p, a) }
        }
      }
      const firstStart = windows.length ? Math.min.apply(null, windows.map(([a]) => a)) : 9 * 60
      for (let i = 1; i <= 45; i++) {
        const q = bjParts(now + i * 86400e3)
        if (!days.includes(q.wd) || set.has(bjDateKey(q))) continue
        return { peak: false, changeAt: bjTs(q, firstStart) }
      }
      return { peak: false, changeAt: null }
    }
    /** 剩余时长：2h / 1h30m / 45m（分钟向上取整，避免显示 0m）。 */
    function formatPeakLeft(ms) {
      const total = Math.max(1, Math.ceil(ms / 60000))
      const h = Math.floor(total / 60)
      const m = total % 60
      if (!h) return m + 'm'
      return m ? h + 'h' + m + 'm' : h + 'h'
    }

    // ---------------------------------------------------------------- 快照首屏
    // DSH 冷启动时 Host 要现查各供应商额度接口（网络请求），首次快照返回前卡片会空白。
    // 这里把上一轮快照缓存到 localStorage，冷启动先回显（标「已过期」），新数据到达即替换；
    // 没有任何缓存时由侧栏骨架卡片占位（见 FooterEntry）。
    const SNAP_CACHE_KEY = 'dmu:snaplast'
    const SNAP_CACHE_TTL = 24 * 3600 * 1000 // 超过一天的旧快照没有回显价值
    let snapCacheWrittenAt = 0
    function readSnapCache() {
      try {
        const raw = window.localStorage.getItem(SNAP_CACHE_KEY)
        if (!raw) return null
        const v = JSON.parse(raw)
        if (!v || !Array.isArray(v.providers) || !v.providers.length) return null
        if (!v.generatedAt || Date.now() - v.generatedAt > SNAP_CACHE_TTL) return null
        // 回显的必然是上一轮数据：统一标 stale，卡片显示「已过期 · 上次时间」；
        // cached 标记让定时器先等首轮全量 load，不在冷启动瞬间并发一圈多余请求
        v.cached = true
        v.providers = v.providers.map((p) => (p && typeof p === 'object' ? { ...p, stale: true } : p))
        return v
      } catch { return null }
    }
    function writeSnapCache(s) {
      try {
        if (!s || !Array.isArray(s.providers) || !s.providers.length) return
        const now = Date.now()
        // 快照按路由高频刷新，写缓存节流 5s（回显只用于冷启动，不需要每轮都落盘）
        if (now - snapCacheWrittenAt < 5000) return
        snapCacheWrittenAt = now
        window.localStorage.setItem(SNAP_CACHE_KEY, JSON.stringify(s))
      } catch { /* 隐私模式/配额不足忽略 */ }
    }

    function useSnapshot(api) {
      const [snap, setSnap] = useState(() => readSnapCache())
      const [busySet, setBusySet] = useState(() => new Set()) // 各卡片独立的刷新中路由集合
      const [refreshSec, setRefreshSec] = useState(60)
      const [cycle, bump] = useState(0) // 刷新完成（含失败）信号：驱动重排定时器
      const inflight = useRef(new Map()) // route -> Promise，同路由的定时/手动刷新合并
      const nextAt = useRef(new Map())   // route -> 下一次自动刷新时刻（完成时间 + 间隔）
      const load = useCallback(async (force, route) => {
        try {
          const opts = force ? { refresh: true } : {}
          if (route) opts.route = route
          const s = await api.snapshot(opts)
          setSnap(s)
          if (s && s.refreshSeconds) setRefreshSec(s.refreshSeconds)
          writeSnapCache(s)
          return true
        } catch { return false /* 保留旧快照 */ }
      }, [api])
      // 每卡片独立刷新：同路由并发合并；完成（无论成败）后排定下一轮，查询耗时不计入间隔
      const refresh = useCallback((route, force = true) => {
        if (!route) return Promise.resolve()
        const flying = inflight.current.get(route)
        if (flying) return flying
        setBusySet((s) => new Set(s).add(route))
        const p = (async () => {
          try { await load(force, route) } finally {
            inflight.current.delete(route)
            nextAt.current.set(route, Date.now() + Math.max(1, refreshSec) * 1000)
            setBusySet((s) => { const n = new Set(s); n.delete(route); return n })
            bump((n) => n + 1)
          }
        })()
        inflight.current.set(route, p)
        return p
      }, [load, refreshSec])
      // 初次全量加载 + 回到前台时对齐一次（TTL 缓存兜底，过期路由由各自定时器补刷）。
      // 冷启动时 Host 路由/插件可能尚未就绪，首次请求失败则有限退避重试，避免卡片一直空白。
      useEffect(() => {
        let alive = true
        let timer = null
        let attempt = 0
        const run = async () => {
          const ok = await load()
          if (!ok && alive && attempt < 5) {
            attempt += 1
            timer = setTimeout(run, Math.min(8000, 500 * 2 ** attempt))
          }
        }
        run()
        const onVis = () => { if (document.visibilityState === 'visible') load() }
        document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [load])
      // 按路由排定下一次自动刷新：优先用完成时排定的 nextAt，否则按 fetchedAt + 间隔
      useEffect(() => {
        if (!snap || !snap.providers || snap.cached) return
        const now = Date.now()
        const timers = []
        for (const p of snap.providers) {
          if (!p.route || inflight.current.has(p.route)) continue
          const at = nextAt.current.get(p.route) || ((p.fetchedAt || now) + Math.max(1, refreshSec) * 1000)
          const wait = Math.max(0, at - now)
          timers.push(setTimeout(() => { if (document.visibilityState === 'visible') refresh(p.route, false) }, wait))
        }
        return () => { for (const t of timers) clearTimeout(t) }
      }, [snap, refreshSec, cycle, refresh])
      const isBusy = useCallback((route) => busySet.has(route), [busySet])
      return { snap, isBusy, refresh }
    }

    function useStats(api, query) {
      const [state, setState] = useState({ stats: null, error: null })
      const load = useCallback(async () => {
        try {
          const v = await api.stats(query)
          if (v == null) throw new Error('stats 接口返回了空数据')
          setState({ stats: v, error: null })
        } catch (e) {
          // 失败必须可见：此前静默吞错导致右栏永远停在「加载中」
          try { console.warn('[dmu-stats] 统计加载失败:', e) } catch {}
          setState((s) => ({ stats: s.stats, error: String((e && e.message) || e) }))
        }
      }, [api, query])
      useEffect(() => {
        load()
        const iv = setInterval(() => { if (document.visibilityState === 'visible') load() }, 60000)
        return () => clearInterval(iv)
      }, [load])
      return { stats: state.stats, error: state.error, reload: load }
    }

    // ---------------------------------------------------------------- 秒级 ticker
    // 单文件交付约束下的唯一实现（test/client-tick.test.js 直接抽取本函数回归）。
    // 「Xs 前」「N 后重置」等相对时间文本每秒重算，但仅在文本变化时 setState，
    // 避免每秒整树重渲染；无订阅者时计时器停止。
    function createTicker(stepMs = 1000) {
      const listeners = new Set()
      let timer = null
      const fire = () => { for (const l of [...listeners]) { try { l() } catch {} } }
      const api = {
        add(l) {
          listeners.add(l)
          if (!timer) {
            timer = setInterval(fire, stepMs)
            if (timer && timer.unref) timer.unref()
          }
          return () => api.remove(l)
        },
        remove(l) {
          listeners.delete(l)
          if (!listeners.size && timer) { clearInterval(timer); timer = null }
        },
        get size() { return listeners.size },
        fire,
      }
      return api
    }
    const relTicker = createTicker()
    /** 每秒重算相对时间文本，仅在变化时更新（compute 经 ref 取最新，避免依赖项抖动）。 */
    function useTickText(compute) {
      const [text, setText] = useState(compute)
      const ref = useRef(compute)
      ref.current = compute
      useEffect(() => {
        const update = () => setText((cur) => { const t = ref.current(); return cur === t ? cur : t })
        update()
        return relTicker.add(update)
      }, [])
      return text
    }

    // ---------------------------------------------------------------- 峰谷/价格联动
    // Host 下发规则与节假日表（pricingEnv，Host 侧 24h 缓存）；每秒 tick 重算提示文本。
    function usePricingEnv(api) {
      const [env, setEnv] = useState(null)
      useEffect(() => {
        let alive = true
        api.pricingEnv().then((v) => { if (alive && v) setEnv(v) }).catch(() => {})
        return () => { alive = false }
      }, [api])
      return env
    }
    /** 当前峰谷状态：{ peak, text }（text = 距下次切换的倒计时）；规则/节假日到达后立即计算。 */
    function usePeakState(env) {
      const holidaySet = useMemo(() => new Set((env && env.holidays) || []), [env])
      const rules = env && env.rules
      const [state, setState] = useState(null)
      const live = useRef({ rules, holidaySet })
      live.current = { rules, holidaySet }
      useEffect(() => {
        const update = () => setState((cur) => {
          const now = live.current
          if (!now.rules) return cur === null ? cur : null
          const ts = Date.now()
          const info = peakInfo(ts, now.rules, now.holidaySet)
          const next = info && info.changeAt ? { peak: !!info.peak, text: formatPeakLeft(info.changeAt - ts) } : null
          if (cur === next) return cur
          if (cur && next && cur.peak === next.peak && cur.text === next.text) return cur
          return next
        })
        update() // env 到达/规则变化后立即显示，不等下一个 tick
        return relTicker.add(update)
      }, [rules, holidaySet])
      return state
    }

    // ---------------------------------------------------------------- 当前会话跟随
    // 插件无构建步骤、客户端必须单文件，本函数即唯一实现
    //（test/client-current-route.test.js 直接抽取本函数回归）。
    // 当前会话判定与 dsh-client-ui-session 的 publishMain 同款口径：
    // uiSession.current > retainedBy.mainView > 列表第一项兜底。
    // 供应商判定与原生输入框（dsh-client-ui-model-selection）同款口径：
    // modelSelection 投影 next/lastUsed > 请求头 logged 供应商 >
    // 浏览器侧模型目录 default（新会话）> Host 默认模型（若可桥接）。
    // 关键：agentDefaultModel 是 Host 服务，浏览器 ctx.get 永远取不到；
    // 新会话的「DSH 默认模型」必须从浏览器侧 modelDirectories 服务读取。
    function trackCurrentRoute(ctx, api, onChange) {
      const sessions = ctx && ctx.sessions
      if (!sessions || !api || typeof onChange !== 'function') return () => {}
      let disposed = false
      let generation = 0
      let lastRoute = null
      const emit = (route, myGen) => {
        if (disposed) return
        if (myGen !== undefined && myGen !== generation) return
        if (!route || route === lastRoute) return
        lastRoute = route
        onChange(route)
      }
      // Host 兜底：最近一次真实模型调用。弱信号：attach() 先递增代际使其失效，
      // 因此新建会话不会被上一会话的供应商粘住
      const seedGen = ++generation
      api.current().then((r) => { if (r && r.route) emit(r.route, seedGen) }).catch(() => {})
      let faceDispose = null
      let faceRead = null // 当前会话投影的读取函数（模型目录/默认值变化时重读）
      // 浏览器侧模型目录：ui-model-selection 插件注册的 client 服务 modelDirectories。
      // 原生输入框的当前模型 = 投影 next ?? 目录 default，这里读同一份数据。
      const modelDirectories = () => {
        try { return typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null } catch { return null }
      }
      const catalogStore = () => {
        try {
          const md = modelDirectories()
          const store = md && md.catalog && md.catalog.store
          return store && typeof store.getSnapshot === 'function' ? store : null
        } catch { return null }
      }
      const catalogDefaultProvider = () => {
        try {
          const store = catalogStore()
          const snap = store ? store.getSnapshot() : null
          const def = snap && snap.value && snap.value.default
          return (def && def.provider) || null
        } catch { return null }
      }
      // 跟随模型目录 default：目录加载完成 / 宿主默认模型变更时自动切换，
      // 新会话无需点模型或发消息
      let catalogOff = null
      const onCatalogChange = () => {
        if (disposed) return
        if (faceRead) { faceRead(); return }
        const dp = catalogDefaultProvider()
        if (dp) emit(dp)
      }
      const ensureCatalogWatch = () => {
        if (catalogOff) return true
        const store = catalogStore()
        if (!store || typeof store.subscribe !== 'function') return false
        try {
          const off = store.subscribe(onCatalogChange)
          catalogOff = typeof off === 'function' ? off : () => {}
          return true
        } catch { return false }
      }
      // 服务晚于本插件就绪时（加载顺序不保证）监听 cordis internal/service，
      // 目录一出现就补挂订阅并跟随默认模型
      let serviceOff = null
      const watchDirectoryService = () => {
        if (serviceOff || catalogOff) return
        if (typeof ctx.on !== 'function') return
        try {
          const off = ctx.on('internal/service', (name, value) => {
            if (name !== 'modelDirectories') return
            if (value == null) {
              if (catalogOff) { try { catalogOff() } catch {} catalogOff = null }
              return
            }
            if (disposed) return
            ensureCatalogWatch()
            if (faceRead) faceRead()
            else { const dp = catalogDefaultProvider(); if (dp) emit(dp) }
          })
          if (typeof off === 'function') serviceOff = off
        } catch { /* 旧内核没有该内部事件 */ }
      }
      // 无会话 / 绑定未就绪时先显示默认模型，后续就绪后再由投影纠正
      const emitCatalogDefault = (myGen) => {
        ensureCatalogWatch()
        watchDirectoryService()
        const dp = catalogDefaultProvider()
        if (dp) emit(dp, myGen)
      }
      // uiSession 是可选服务：cordis 不允许访问未 inject 的服务属性（会抛错），
      // 且它可能晚于本插件就绪，因此每次按需读取而不是缓存一次
      const uiSessionService = () => {
        try { return typeof ctx.get === 'function' ? ctx.get('uiSession') : null } catch { return null }
      }
      const getSnapshot = (obs) => { try { return obs.getSnapshot() } catch { return null } }
      const currentSessionId = () => {
        const uiSession = uiSessionService()
        const cur = uiSession && uiSession.current
        if (cur && typeof cur.getSnapshot === 'function') {
          const v = getSnapshot(cur)
          if (v && v.key) return v.key
        }
        const snap = sessions.list && typeof sessions.list.getSnapshot === 'function' ? getSnapshot(sessions.list) : null
        const byId = (snap && snap.byId) || {}
        for (const [id, row] of Object.entries(byId)) {
          const retained = row && row.retainedBy
          if (retained && (retained.mainView || 0) > 0) return id
        }
        const ids = Object.keys(byId)
        return ids[0] || null
      }
      // DSH 默认模型（agentDefaultModel）：Host 服务，浏览器侧通常取不到，
      // 仅作为旧内核/未来桥接的最后兜底
      const defaultProvider = () => {
        try {
          const adm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
          const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
          return (sel && sel.provider) || null
        } catch { return null }
      }
      // 与 api-session 的 selection.current 同款的请求头回退：
      // 会话最近一次的请求头里带着 logged provider/model
      const loggedProvider = (binding) => {
        try {
          const h = binding && binding.session && typeof binding.session.requestHeader === 'function' ? binding.session.requestHeader() : null
          return (h && h.config && h.config.provider) || null
        } catch { return null }
      }
      const readFace = (face, myGen, binding) => {
        try {
          const v = face.getSnapshot()
          const pick = (v && v.next) || (v && v.lastUsed) || null
          if (pick && pick.provider) { emit(pick.provider, myGen); return }
          // 会话已有历史请求头时优先跟随它（投影回放滞后时也能对准）
          const logged = loggedProvider(binding)
          if (logged) { emit(logged, myGen); return }
          // 新会话尚无模型选择记录：原生输入框展示的就是模型目录 default，
          // 这里读同一份目录并订阅其变化，立即跟随 DSH 默认模型
          ensureCatalogWatch()
          watchDirectoryService()
          const dp = catalogDefaultProvider()
          if (dp) { emit(dp, myGen); return }
          const fallback = defaultProvider()
          if (fallback) emit(fallback, myGen)
        } catch { /* 投影未就绪 */ }
      }
      const attachToBinding = (binding, myGen) => {
        try {
          const face = binding && binding.session && binding.session.projections && binding.session.projections.faceOf('modelSelection')
          if (!face) return false
          faceRead = () => readFace(face, myGen, binding)
          faceRead()
          const unsub = face.subscribe(faceRead)
          if (typeof unsub === 'function') {
            const prev = faceDispose
            faceDispose = () => { try { if (prev) prev() } catch {} try { unsub() } catch {} }
          }
          return true
        } catch { return false }
      }
      // 新会话的绑定/投影可能尚未就绪：有限退避重试（代际保护，切会话/销毁即失效）
      let retryTimer = null
      const scheduleRetry = (myGen, attempt) => {
        if (attempt > 5) return
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (disposed || myGen !== generation) return
          attach(attempt + 1)
        }, 200 * Math.pow(2, attempt - 1))
      }
      const attach = (attempt = 1) => {
        const myGen = ++generation
        if (faceDispose) { try { faceDispose() } catch {} faceDispose = null }
        faceRead = null
        ensureCatalogWatch()
        watchDirectoryService()
        const id = currentSessionId()
        if (!id) {
          // 新建对话首页尚无会话 id：直接跟随默认模型
          emitCatalogDefault(myGen)
          return
        }
        try {
          const binding = sessions.binding(id)
          if (binding) {
            if (attachToBinding(binding, myGen)) return
          }
          // 新会话绑定/投影尚未就绪：先按默认模型显示，再退避重试
          emitCatalogDefault(myGen)
          scheduleRetry(myGen, attempt)
        } catch {
          emitCatalogDefault(myGen)
          scheduleRetry(myGen, attempt)
        }
      }
      attach()
      const unsubs = []
      try {
        if (sessions.list && typeof sessions.list.subscribe === 'function') unsubs.push(sessions.list.subscribe(attach))
      } catch { /* 无列表订阅 */ }
      try {
        const uiSession = uiSessionService()
        const cur = uiSession && uiSession.current
        if (cur && typeof cur.subscribe === 'function') unsubs.push(cur.subscribe(attach))
      } catch { /* 无 uiSession */ }
      return () => {
        disposed = true
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        if (catalogOff) { try { catalogOff() } catch {} catalogOff = null }
        if (serviceOff) { try { serviceOff() } catch {} serviceOff = null }
        for (const u of unsubs) { try { u && u() } catch {} }
        if (faceDispose) { try { faceDispose() } catch {} faceDispose = null }
      }
    }

    // ---------------------------------------------------------------- 共用组件
    function WinRow({ w, tr, resets, onResetWindow }) {
      const used = Math.round(w.usedPct || 0)
      const left = 100 - used
      const reset = useTickText(() => fmtReset(w.resetAt, tr))
      // 该窗口类型的可核销机会数（rolling→5 小时 / weekly→周）
      const chances = w.key === 'rolling'
        ? (resets && resets.fiveHour && resets.fiveHour.count) || 0
        : w.key === 'weekly'
          ? (resets && resets.week && resets.week.count) || 0
          : 0
      const label = w.label || ({ daily: tr('windowDaily'), weekly: tr('windowWeekly'), monthly: tr('windowMonthly'), rolling: tr('windowRolling') }[w.key] || w.key)
      const head = w.countBased && w.remaining != null
        ? String(w.remaining) + (w.limit != null ? tr('of') + w.limit : '')
        : tr('leftCompact', { n: left + '%' })
      const lv = used >= 80 ? 'err' : used >= 50 ? 'warn' : 'ok'
      // 余量配色（if 链短路）：>=60% 蓝 / >=30% 绿 / >=5% 橘 / <5% 亮红
      const fillColor = left >= 60 ? 'var(--dsw-alias-state-business-primary, #4176e6)'
        : left >= 30 ? 'var(--dsw-alias-state-success-primary, #12b76a)'
        : left >= 5 ? 'var(--dsw-alias-state-warn-primary, #f79009)'
        : 'var(--dsw-alias-state-error-primary, #ff3b30)'
      return h('div', { className: 'dmu-win dmu-win-' + lv },
        h('div', { className: 'dmu-win-head' },
          h('span', { className: 'dmu-win-label' }, label),
          h('b', null, head)),
        h('div', { className: 'dmu-win-track' },
          h('div', { className: 'dmu-win-fill', style: { '--dmu-fill': left + '%', background: fillColor } })),
        // 滚动窗口 0% 时接口不下发重置时间（窗口未开始）：明确提示而非留空；
        // 有可核销机会时，重置按钮渲染在倒计时行最右侧
        (reset || used === 0 || chances > 0) ? h('div', { className: 'dmu-win-foot' },
          h('span', null, reset ? tr('resetIn', { t: reset }) : (used === 0 ? tr('winIdle') : '')),
          chances > 0 && onResetWindow
            ? h('button', {
                className: 'dmu-resetbtn',
                onClick: (e) => { e.stopPropagation(); onResetWindow(w.key, chances) },
              }, tr('resetAction') + ' ' + chances)
            : null) : null)
    }

    /** 卡片主要指标：剩余额度 > 余额；纯窗口型供应商不显示大数字（窗口条本身就是主信息，避免重复）。
     *  峰谷状态存在时：大数字按峰/谷着色；悬停判定只认文字本身（内层 inline 气泡），
     *  整行空白处不触发；提示显示在鼠标指针上方、左下角对齐指针。 */
    function MainMetric({ p, tr, template, peak }) {
      const [tip, setTip] = useState(null) // { x, y, w, ready }：指针坐标 + 实测宽度（用于水平钳位）
      const tipRef = useRef(null)
      const peakText = peak ? tr(peak.peak ? 'peakTipPeak' : 'peakTipValley') : ''
      const show = (e) => {
        if (!peakText) return
        setTip({ x: e.clientX, y: e.clientY, w: 0, ready: false })
      }
      const move = (e) => {
        if (!peakText) return
        setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
      }
      const hide = () => setTip(null)
      // 提示渲染后实测宽度并水平钳位（首帧离屏，避免在右缘闪出再回弹）
      useEffect(() => {
        if (!tip || tip.ready || !tipRef.current) return
        setTip((t) => (t ? { ...t, w: tipRef.current.offsetWidth, ready: true } : t))
      }, [tip])
      const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0
      const tipLeft = tip && tip.ready && vw > 0
        ? Math.min(Math.max(tip.x, 8), Math.max(8, vw - tip.w - 8))
        : null
      const cls = 'dmu-big' + (peak ? (peak.peak ? ' dmu-price-peak' : ' dmu-price-valley') : '')
      // 悬停提示由本组件自绘（与热力图同款深色气泡），不再用原生 title
      const tipProps = peakText ? { 'aria-label': peakText, onMouseEnter: show, onMouseMove: move, onMouseLeave: hide } : {}
      let metric = null
      if (template) {
        const out = renderTemplate(template, providerVars(p, tr))
        if (out) metric = h('div', { className: cls }, h('span', { className: 'dmu-bigtext', ...tipProps }, out))
      }
      if (!metric && p.quota && p.quota.remaining != null) {
        metric = h('div', { className: cls },
          h('span', { className: 'dmu-bigtext', ...tipProps },
            fmtMoney(p.quota.remaining, p.quota.unit),
            p.quota.limit != null ? h('small', null, ' / ' + fmtMoney(p.quota.limit, p.quota.unit)) : null))
      }
      if (!metric && p.balance) {
        metric = h('div', { className: cls }, h('span', { className: 'dmu-bigtext', ...tipProps }, curSym(p.balance.currency) + p.balance.total))
      }
      if (!metric) return null
      return h(React.Fragment, null,
        metric,
        tip && peakText ? h('div', {
          className: 'dmu-peak-tip', ref: tipRef, role: 'tooltip',
          style: { left: (tipLeft == null ? -9999 : tipLeft) + 'px', top: (tip.y - 6) + 'px' },
        }, peakText) : null)
    }

    /** 供应商完整信息卡：侧栏与弹窗左列共用同一组件，信息一致 */
    function ProviderCard({ p, tr, template, busy, onRefresh, onOpen, active, onAccount, onResetWindow, peakState }) {
      const st = stateOf(p)
      // 峰谷只对 DeepSeek 官方计费有意义（Kimi/GLM 无峰谷价）
      const isDeepSeekCard = /^deepseek/i.test(String(p.route || '')) || /^deepseek/i.test(String(p.adapter || ''))
      const peak = isDeepSeekCard ? peakState : null
      const open = () => { if (onOpen) onOpen() }
      const ago = useTickText(() => relTime(p.fetchedAt))
      const kids = []
      // GLM 卡片：左上角 Logo 即账户入口（未连接时灰度，点击打开账户对话框）
      const logoNode = p.adapter === 'glm-coding' && onAccount
        ? h('span', {
            className: 'dmu-logo-btn' + (p.zcodeConnected ? ' connected' : ''),
            role: 'button', tabIndex: 0, title: tr('connectZcode'), 'aria-label': tr('account'),
            onClick: (e) => { e.stopPropagation(); onAccount(p.route) },
            onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); onAccount(p.route) } },
          }, h(Logo, { p, size: 22 }))
        : h(Logo, { p, size: 22 })
      kids.push(h('div', { className: 'dmu-pcard-top', key: 'top' },
        logoNode,
        h('span', { className: 'dmu-pcard-name' }, p.displayName || p.route),
        p.plan ? h('span', { className: 'dmu-pill' }, p.plan) : null,
        h('span', { className: 'dmu-pcard-side' },
          (ago || p.stale) ? h('span', { className: 'dmu-pcard-time' }, (p.stale ? tr('stale') + ' · ' : '') + ago) : null,
          onRefresh ? h('button', {
            className: 'dmu-iconbtn', title: tr('refresh'), 'aria-label': tr('refresh'), disabled: busy,
            onClick: (e) => { e.stopPropagation(); onRefresh(p.route) },
          }, '↻') : null)))
      const metric = h(MainMetric, { p, tr, template, peak })
      if (metric) kids.push(h('div', { key: 'big' }, metric))
      if (p.balance) {
        const top = Number(p.balance.toppedUp) || 0
        const gra = Number(p.balance.granted) || 0
        if (top > 0 && gra > 0) {
          const wTop = Math.round((top / (top + gra)) * 100)
          kids.push(h('div', { className: 'dmu-seg', key: 'seg' },
            h('span', { className: 'a', style: { '--dmu-seg': wTop + '%' } }),
            h('span', { className: 'b', style: { '--dmu-seg': (100 - wTop) + '%' } })))
        }
        const parts = []
        if (p.balance.toppedUp) parts.push(tr('toppedUp') + ' ' + curSym(p.balance.currency) + p.balance.toppedUp)
        if (p.balance.granted && p.balance.granted !== '0' && p.balance.granted !== '0.00') parts.push(tr('granted') + ' ' + curSym(p.balance.currency) + p.balance.granted)
        // 充值/赠金说明行；峰谷倒计时并入同一行右对齐（无说明文字时也保留右对齐倒计时）
        if (parts.length || (peak && peak.text)) {
          kids.push(h('div', { className: 'dmu-cap dmu-balrow', key: 'bc' },
            h('span', { className: 'dmu-baltext' }, parts.join(' · ')),
            peak && peak.text ? h('span', { className: 'dmu-peak-count' }, peak.text) : null))
        }
      } else if (peak && peak.text) {
        kids.push(h('div', { className: 'dmu-cap dmu-balrow', key: 'bc' },
          h('span', { className: 'dmu-baltext' }, ''),
          h('span', { className: 'dmu-peak-count' }, peak.text)))
      }
      if (p.quota && p.quota.used != null && !(p.windows && p.windows.length)) {
        kids.push(h('div', { className: 'dmu-cap', key: 'qc' }, tr('usedUp') + ' ' + fmtMoney(p.quota.used, p.quota.unit)))
      }
      if (p.windows && p.windows.length) {
        kids.push(h('div', { className: 'dmu-wins', key: 'w' }, p.windows.map((w, i) => h(WinRow, { key: w.key || i, w, tr, resets: p.resets, onResetWindow: onResetWindow ? (key, chances) => onResetWindow(p.route, key, chances) : undefined }))))
      }
      if (p.daysUntilExpiry != null) {
        kids.push(h('div', { className: 'dmu-cap', key: 'e' }, p.daysUntilExpiry > 0 ? tr('expiresIn', { d: p.daysUntilExpiry }) : tr('expired')))
      }
      if (p.status === 'needs-credential') kids.push(h('div', { className: 'dmu-warn', key: 'nc' }, tr('needsCred')))
      else if (p.status === 'needs-signin') kids.push(h('div', { className: 'dmu-warn', key: 'ns' }, tr('needsSignin')))
      if (p.valid === false) kids.push(h('div', { className: 'dmu-err', key: 'v' }, tr('invalid')))
      else if (p.error) kids.push(h('div', { className: 'dmu-err', key: 'err' }, p.error.message || ''))
      return h('div', {
        className: 'dmu-pcard dmu-st-' + st + (active ? ' active' : ''),
        role: onOpen ? 'button' : undefined, tabIndex: onOpen ? 0 : undefined,
        onClick: onOpen, onKeyDown: onOpen ? (e) => { if (e.key === 'Enter') open() } : undefined,
      }, kids)
    }

    // ---------------------------------------------------------------- 弹窗右栏：固定摘要 + 分区统计
    /** 悬停提示水平位置钳位：按提示实际宽度与容器宽度计算，保证完整落在容器内。
     *  无布局信息（hostW=0，如 jsdom）时退化为居中，交由真实浏览器二次测量修正。 */
    function clampTipLeft(cx, tipW, hostW) {
      if (!(hostW > 0)) return cx
      const half = tipW / 2
      return Math.min(Math.max(cx - half, 0), Math.max(0, hostW - tipW))
    }

    /** 近 12 个月用量热力图（GitHub 风格：列=周，行=星期；无标题，仅月份标签） */
    function Heatmap({ days, tr }) {
      const map = new Map((days || []).map((d) => [d.date, d]))
      const max = Math.max.apply(null, (days || []).map((d) => d.tokens).concat([1]))
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const start = new Date(today); start.setDate(start.getDate() - (51 * 7 + today.getDay()))
      const cols = []
      const labels = []
      let labeledMonth = -1
      for (let w = 0; w < 52; w++) {
        const col = []
        for (let d = 0; d < 7; d++) {
          const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d)
          if (dt > today) { col.push(null); continue }
          const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
          const e = map.get(key)
          col.push({ date: key, month: dt.getMonth(), dayOfMonth: dt.getDate(), tokens: (e && e.tokens) || 0, requests: (e && e.requests) || 0 })
        }
        // 月份标签只打在「包含当月 1 日」的列（GitHub 口径）：
        // 保证相邻标签间隔 ≥4 列，起始日落月末时不会出现「4月5月」挤在一起
        let label = null
        for (const cell of col) {
          if (cell && cell.dayOfMonth === 1 && cell.month !== labeledMonth) {
            label = cell.month
            labeledMonth = cell.month
            break
          }
        }
        labels.push(label)
        cols.push(col)
      }
      const monthName = (m) => tr('lang') === 'en'
        ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]
        : (m + 1) + '月'
      // 零用量也渲染浅灰占位格（与用量条轨道同款灰），而不是留白看不见
      const levelColor = (t) => {
        if (t <= 0) return 'color-mix(in srgb, var(--dsw-alias-label-tertiary, #98a2b3) 25%, #fff)'
        const r = t / max
        const pct = r < 0.25 ? 25 : r < 0.5 ? 50 : r < 0.75 ? 75 : 100
        return 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) ' + pct + '%, #fff)'
      }
      const cellTitle = (cell) => {
        const reqs = cell.requests || 0
        const calls = tr('lang') === 'en' ? reqs + ' calls' : '调用 ' + reqs + ' 次'
        return cell.date + ' · ' + fmtNum(cell.tokens, tr) + ' tokens · ' + calls
      }
      // 悬停提示：触发时实测单元格与容器位置，按提示实际宽度钳位在容器内（不依赖列位置猜测）
      const heatRef = useRef(null)
      const tipRef = useRef(null)
      const [tip, setTip] = useState(null) // { text, cx, top, hostH, left }
      const showTip = (e, cell) => {
        if (!cell || !heatRef.current) return
        const r = e.currentTarget.getBoundingClientRect()
        const host = heatRef.current.getBoundingClientRect()
        setTip({ text: cellTitle(cell), cx: r.left + r.width / 2 - host.left, top: r.top - host.top, hostH: host.height, left: null })
      }
      const hideTip = () => setTip(null)
      // 提示渲染后测量实际宽度并钳位（先离屏避免闪动）
      useEffect(() => {
        if (!tip || tip.left != null || !tipRef.current || !heatRef.current) return
        const w = tipRef.current.offsetWidth
        const hostW = heatRef.current.getBoundingClientRect().width
        const left = clampTipLeft(tip.cx, w, hostW)
        setTip((t) => (t && t.left == null ? { ...t, left } : t))
      }, [tip])
      return h('div', { className: 'dmu-heat', ref: heatRef },
        h('div', { className: 'dmu-heat-months' }, labels.map((l, i) => h('span', { key: i }, l == null ? '' : monthName(l)))),
        h('div', { className: 'dmu-heat-grid' }, cols.map((col, w) => col.map((cell, d) =>
          h('span', {
            key: w * 7 + d, className: 'dmu-heat-cell',
            'aria-label': cell ? cellTitle(cell) : undefined,
            onMouseEnter: cell ? (e) => showTip(e, cell) : undefined,
            onMouseLeave: cell ? hideTip : undefined,
            style: cell ? { background: levelColor(cell.tokens) } : { visibility: 'hidden' },
          })))),
        tip ? h('div', {
          className: 'dmu-heat-tip', ref: tipRef, role: 'tooltip',
          style: {
            top: tip.top - 6 + 'px', transform: 'translateY(-100%)',
            left: tip.left == null ? '-9999px' : tip.left + 'px',
          },
        }, tip.text) : null)
    }


    /** 固定顶部：今日 / 本月 / 累计 + 热力图（不随 tabs 与滚动变化） */
    function SummaryTop({ stats, tr }) {
      const card = (label, v) => h('div', { className: 'dmu-sumcard', key: label },
        h('div', { className: 'k' }, label),
        h('div', { className: 'v' }, fmtNum(v.tokens, tr), h('small', null, 'tokens')),
        h('div', { className: 's' }, tr('callsIn', { r: String(v.requests || 0), i: fmtNum(v.input, tr) })),
        h('div', { className: 's' }, tr('cacheOut', { c: fmtNum((v.cacheRead || 0) + (v.cacheWrite || 0), tr), o: fmtNum(v.output, tr) })))
      return h('div', { className: 'dmu-summary' },
        h('div', { className: 'dmu-sumcards' },
          card(tr('sumToday'), stats.today || {}),
          card(tr('sumWeek'), stats.week || {}),
          card(tr('sumMonth'), stats.month || {}),
          card(tr('sumTotal'), stats.total || {})),
        h(Heatmap, { days: stats.heatmap, tr }))
    }

    /** 折叠分区（受控：open/onToggle 由父级管理并持久化） */
    function Section({ title, open, onToggle, children }) {
      return h('div', { className: 'dmu-sec' + (open ? ' open' : '') },
        h('button', { className: 'dmu-sec-head', onClick: () => onToggle(!open), 'aria-expanded': open },
          h('span', { className: 'dmu-sec-arrow' }, open ? '▾' : '▸'), title),
        open ? h('div', { className: 'dmu-sec-body' }, children) : null)
    }

    /** UI 偏好持久化（统计范围 tab + 各分区展开态；localStorage，刷新/重启后保留） */
    const PREFS_KEY = 'dmu:prefs'
    function loadPrefs() {
      try { return JSON.parse(window.localStorage.getItem(PREFS_KEY)) || {} } catch { return {} }
    }
    function savePrefs(patch) {
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })) } catch { /* 隐私模式等场景忽略 */ }
    }

    /** 统一网格表头：名称 + 调用次数/输入 tokens/缓存 tokens/输出 tokens */
    function GridHead({ tr, nameHeader }) {
      return h('div', { className: 'dmu-mrow dmu-mrow-c5 dmu-mrow-head' },
        h('span', null, nameHeader),
        h('span', { className: 'n' }, tr('thCalls')),
        h('span', { className: 'n' }, tr('thInput')),
        h('span', { className: 'n' }, tr('thCache')),
        h('span', { className: 'n' }, tr('thOutput')))
    }

    /** 统一网格数据行（行形：{ key, name, display, title?, requests, input, cache, output }） */
    function GridRow({ row: r, tr }) {
      return h('div', { className: 'dmu-mrow dmu-mrow-c5' },
        h('span', { className: 'dmu-mname', title: r.title || r.name }, r.display),
        h('span', { className: 'n' }, String(r.requests)),
        h('span', { className: 'n' }, fmtNum(r.input, tr)),
        h('span', { className: 'n' }, fmtNum(r.cache, tr)),
        h('span', { className: 'n' }, fmtNum(r.output, tr)))
    }

    /** 渠道/会话/历史通用统计表（与模型统计同款五列网格；plainName 首列常规字重） */
    function StatRows({ rows, tr, nameHeader, plainName }) {
      if (!rows.length) return h('div', { className: 'dmu-muted' }, tr('noData'))
      return h('div', { className: 'dmu-mtable' + (plainName ? ' dmu-mtable-convos' : '') },
        h(GridHead, { tr, nameHeader }),
        rows.map((r) => h(GridRow, { key: r.key || r.name, row: r, tr })))
    }

    /** 模型统计表：五列网格 + 行可展开显示该模型的每次调用（recent 中 p/m 与行名匹配的记录） */
    function ModelStatRows({ rows, recent, tr }) {
      const [expanded, setExpanded] = useState(null)
      if (!rows.length) return h('div', { className: 'dmu-muted' }, tr('noData'))
      return h('div', { className: 'dmu-mtable' },
        h(GridHead, { tr, nameHeader: tr('thModel') }),
        rows.map((r) => {
          const calls = (recent || []).filter((c) => c.p + '/' + (c.m || '') === r.name)
          const open = expanded === r.name
          return h('div', { key: r.name, className: 'dmu-mgroup' },
            h('div', {
              className: 'dmu-mrow dmu-mrow-c5 dmu-mrow-btn' + (calls.length ? ' clickable' : ''),
              onClick: calls.length ? () => setExpanded(open ? null : r.name) : undefined,
            },
              h('span', { className: 'dmu-mname', title: r.name },
                // 无调用记录的行渲染空占位符，保证所有模型名称左对齐
                h('span', { className: 'dmu-chev' + (open ? ' open' : '') + (calls.length ? '' : ' dmu-chev-empty'), 'aria-hidden': true },
                  calls.length ? h(IcoChevron) : null),
                r.display),
              h('span', { className: 'n' }, String(r.requests)),
              h('span', { className: 'n' }, fmtNum(r.input, tr)),
              h('span', { className: 'n' }, fmtNum(r.cache, tr)),
              h('span', { className: 'n' }, fmtNum(r.output, tr))),
            // 展开列表与上层同一五列网格（时间 | 调用次数 | 输入 | 缓存 | 输出），列严格对齐
            open ? h('div', { className: 'dmu-mcalls' },
              calls.slice(0, 20).map((c, i) => h('div', { className: 'dmu-mrow dmu-mrow-c5 dmu-mrow-call', key: i },
                h('span', { className: 'dmu-mname dmu-dim' }, relTime(c.t) || '—'),
                h('span', { className: 'n' }, '1'),
                h('span', { className: 'n' }, fmtNum(c.i || 0, tr)),
                h('span', { className: 'n' }, fmtNum((c.cr || 0) + (c.cw || 0), tr)),
                h('span', { className: 'n' }, fmtNum(c.o || 0, tr)))))
              : null)
        }))
    }

    function toStatRow(m, stripPrefix) {
      return {
        name: m.name,
        display: stripPrefix && m.name.includes('/') ? m.name.slice(m.name.indexOf('/') + 1) : m.name,
        requests: m.requests || 0,
        input: m.input || 0,
        cache: (m.cacheRead || 0) + (m.cacheWrite || 0),
        output: m.output || 0,
      }
    }

    function StatsPane({ api, tr, sessionName }) {
      // 默认「全部」（全量视图，历史统计完整；用户可再按需切换范围）；此后记住上次选择（localStorage）
      const [tab, setTabState] = useState(() => loadPrefs().tab || 'total')
      const setTab = useCallback((v) => { setTabState(v); savePrefs({ tab: v }) }, [])
      // 四个分区默认收起；此后记住用户上次的展开态
      const [openMap, setOpenMap] = useState(() => ({
        convos: false, models: false, channels: false, global: false,
        ...(loadPrefs().sections || {}),
      }))
      const toggleSec = useCallback((key) => (v) => {
        setOpenMap((m) => {
          const n = { ...m, [key]: v }
          savePrefs({ sections: n })
          return n
        })
      }, [])
      // 今日/全部按天数，本周/本月按日历 scope（Host 账本口径）；useMemo 固定引用避免重复拉取
      const query = useMemo(() => (tab === 'today' ? { days: 1 } : tab === 'total' ? { days: 180 } : { scope: tab }), [tab])
      const { stats, error, reload } = useStats(api, query)
      const tabBtn = (v, label) => h('button', {
        className: 'dmu-tab' + (tab === v ? ' active' : ''), onClick: () => setTab(v),
      }, label)
      if (!stats) {
        return h('div', { className: 'dmu-pane-scroll' },
          error
            ? [h('div', { className: 'dmu-err', key: 'e' }, error),
               h('button', { className: 'dmu-btn', key: 'r', style: { marginTop: '8px' }, onClick: reload }, tr('retry'))]
            : h('div', { className: 'dmu-muted' }, tr('loading')))
      }
      const convos = stats.conversations || []
      return [
        h(SummaryTop, { key: 'sum', stats, tr }),
        h('div', { className: 'dmu-pane-scroll', key: 'scroll' },
          h('div', { className: 'dmu-tabs' },
            tabBtn('today', tr('tabToday')), tabBtn('week', tr('tabWeek')), tabBtn('month', tr('tabMonth')), tabBtn('total', tr('tabAll'))),
          // 四种统计统一信息列：名称 + 调用次数/输入 tokens/缓存 tokens/输出 tokens
          h(Section, { title: tr('secConversations'), open: openMap.convos, onToggle: toggleSec('convos') },
            h(StatRows, {
              tr, nameHeader: tr('thConversation'), plainName: true,
              rows: convos.slice(0, 10).map((c) => ({
                key: c.session, name: c.session, title: c.session,
                display: sessionName ? sessionName(c.session) : c.session,
                requests: c.requests, input: c.input,
                cache: (c.cacheRead || 0) + (c.cacheWrite || 0), output: c.output,
              })),
            })),
          h(Section, { title: tr('secModels'), open: openMap.models, onToggle: toggleSec('models') },
            h(ModelStatRows, { rows: (stats.models || []).map((m) => toStatRow(m, true)), recent: stats.recent, tr })),
          h(Section, { title: tr('secChannels'), open: openMap.channels, onToggle: toggleSec('channels') },
            h(StatRows, { rows: (stats.providers || []).map((m) => toStatRow(m, false)), tr, nameHeader: tr('thProvider') })),
          h(Section, { title: tr('secGlobal'), open: openMap.global, onToggle: toggleSec('global') },
            h(StatRows, {
              tr, nameHeader: tr('thDate'),
              // 只展示有用量的日期，空白日期不占位
              rows: (stats.days || [])
                .filter((d) => (d.requests || 0) > 0 || (d.tokens || 0) > 0)
                .map((d) => ({
                  key: d.date, name: d.date, display: d.date,
                  requests: d.requests, input: d.input,
                  cache: (d.cacheRead || 0) + (d.cacheWrite || 0), output: d.output,
                })),
            })))]
    }



    /** 右向 chevron（模型统计二级展开指示；展开时旋转 90°） */
    const IcoChevron = () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, width: 10, height: 10 },
      h('path', { d: 'M9 18l6-6-6-6' }))

    const IcoGitHub = () => h('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true, width: 15, height: 15 },
      h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }))
    const IcoX = () => h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, width: 14, height: 14 },
      h('path', { d: 'M3 3l10 10M13 3L3 13', strokeLinecap: 'round' }))

    function UsageModal({ api, snap, isBusy, refresh, onClose, tr, sessionName, onAccount, onResetWindow, peakState }) {
      const providers = ((snap && snap.providers) || []).filter((p) => p.status !== 'idle')
      const template = (snap && snap.card && snap.card.template) || ''
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      const anyBusy = providers.some((p) => isBusy(p.route))
      const refreshAll = () => { for (const p of providers) refresh(p.route) }
      return h('div', { className: 'dmu-overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'dmu-modal', role: 'dialog', 'aria-label': tr('nav') },
          h('div', { className: 'dmu-modal-head' },
            h('span', { className: 'dmu-modal-title' }, tr('nav')),
            h('button', { className: 'dmu-iconbtn dmu-headbtn', title: 'GitHub', 'aria-label': 'GitHub', onClick: () => { try { window.open(REPO_URL, '_blank', 'noopener,noreferrer') } catch {} } }, h(IcoGitHub)),
            h('button', { className: 'dmu-iconbtn dmu-headbtn', title: tr('close'), 'aria-label': tr('close'), onClick: onClose }, h(IcoX))),
          h('div', { className: 'dmu-cols' },
            h('div', { className: 'dmu-list' },
              h('div', { className: 'dmu-toolbar' },
                h('button', { className: 'dmu-btn dmu-toolbtn', onClick: refreshAll, disabled: anyBusy }, '↻ ', tr('refreshAll'))),
              providers.map((p) => h(ProviderCard, {
                key: p.route, p, tr, template, busy: isBusy(p.route),
                onRefresh: refresh, onAccount, onResetWindow, peakState,
              })),
              providers.length === 0 ? h('div', { className: 'dmu-muted' }, tr('noData')) : null),
            h('div', { className: 'dmu-detail' },
              h(StatsPane, { api, tr, sessionName })))))
    }


    // ---------------------------------------------------------------- 对话框（可重置额度 / ZCode 账户）
    /** 单条重置行：类型 + 次数药丸 + 最早过期倒计时（秒级刷新）+ 重置按钮 */
    function QuotaResetRow({ api, tr, row, busyType, doneType, onRun }) {
      const expire = useTickText(() => fmtReset(row.expireAt, tr))
      return h('div', { className: 'dmu-quota-row' },
        h('div', { className: 'dmu-quota-row-info' },
          h('div', { className: 'dmu-quota-row-title' }, row.label, h('span', { className: 'dmu-pill dmu-pill-green' }, tr('chancesPill', { n: row.count }))),
          h('div', { className: 'dmu-quota-row-sub' }, expire ? tr('fastestExpire', { t: expire }) : '')),
        h('button', { className: 'dmu-btn dmu-quota-use', disabled: !!busyType, onClick: () => onRun(row.type) },
          busyType === row.type ? tr('resetting') : doneType === row.type ? '✓' : tr('resetAction')))
    }

    /** 「可重置额度」弹窗（ZCode 同款）：上半当前额度卡片，下半两类重置行 */
    function ResetQuotaDialog({ api, tr, p, onClose, onDone }) {
      const [busyType, setBusyType] = useState(null)
      const [error, setError] = useState('')
      const [doneType, setDoneType] = useState(null)
      const winColor = (key) => key === 'weekly' ? 'var(--dsw-alias-state-success-primary, #12b76a)'
        : key === 'mcp' ? 'var(--dsw-alias-state-warn-primary, #b36aee)'
        : 'var(--dsw-alias-state-business-primary, #4176e6)'
      const resetAtText = (ts) => {
        if (!ts) return ''
        const d = new Date(ts)
        if (ts - Date.now() < 86400000) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        return (d.getMonth() + 1) + '月' + d.getDate() + '日'
      }
      const run = async (type) => {
        setBusyType(type)
        setError('')
        try {
          await api.resetUse(type)
          setDoneType(type)
          setTimeout(() => onDone(), 600)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusyType(null)
        }
      }
      const resets = p.resets || {}
      const rows = []
      if (resets.fiveHour && resets.fiveHour.count > 0) rows.push({ type: 'FIVE_HOUR', label: tr('fiveHourReset'), count: resets.fiveHour.count, expireAt: resets.fiveHour.earliestExpireAt })
      if (resets.week && resets.week.count > 0) rows.push({ type: 'WEEK', label: tr('weekReset'), count: resets.week.count, expireAt: resets.week.earliestExpireAt })
      return h('div', { className: 'dmu-overlay', onClick: (e) => { if (e.target === e.currentTarget && !busyType) onClose() } },
        h('div', { className: 'dmu-dialog dmu-dialog-quota', role: 'dialog', 'aria-label': tr('resetQuotaTitle') },
          h('div', { className: 'dmu-dialog-head' },
            h('span', { className: 'dmu-dialog-title' }, tr('resetQuotaTitle')),
            h('button', { className: 'dmu-iconbtn dmu-headbtn', title: tr('close'), 'aria-label': tr('close'), onClick: onClose }, h(IcoX))),
          (p.windows && p.windows.length) ? h('div', { className: 'dmu-quota-cards' },
            p.windows.map((w, i) => {
              const left = 100 - Math.round(w.usedPct || 0)
              return h('div', { className: 'dmu-quota-card', key: i },
                h('div', { className: 'k' }, w.label || w.key),
                h('div', { className: 'v' }, left + '%', resetAtText(w.resetAt) ? h('small', null, resetAtText(w.resetAt)) : null),
                h('div', { className: 'dmu-quota-track' },
                  h('span', { style: { width: left + '%', background: winColor(w.key) } })))
            })) : null,
          rows.length
            ? rows.map((r) => h(QuotaResetRow, { key: r.type, api, tr, row: r, busyType, doneType, onRun: run }))
            : h('div', { className: 'dmu-muted' }, tr('noChances')),
          error ? h('div', { className: 'dmu-err' }, error) : null))
    }

    /** ZCode 账户对话框：连接状态 + 内嵌登录（去授权 → 粘贴回调链接）+ 断开 */
    function AccountDialog({ api, tr, onClose, onChanged }) {
      const [st, setSt] = useState(null)
      const [login, setLogin] = useState(null)
      const [input, setInput] = useState('')
      const [pending, setPending] = useState(false)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try { setSt(await api.zcodeAuthState()) } catch (e) { setError(String((e && e.message) || e)) }
      }, [api])
      useEffect(() => { load() }, [load])
      const start = async () => {
        setPending(true); setError('')
        try {
          const r = await api.zcodeLoginStart()
          setLogin(r)
          try { window.open(r.url, '_blank', 'noopener,noreferrer') } catch {}
        } catch (e) { setError(String((e && e.message) || e)) } finally { setPending(false) }
      }
      const finish = async () => {
        setPending(true); setError('')
        try {
          await api.zcodeLoginComplete(input)
          setLogin(null); setInput('')
          await load()
          onChanged && onChanged()
        } catch (e) { setError(String((e && e.message) || e)) } finally { setPending(false) }
      }
      const disconnect = async () => {
        setPending(true); setError('')
        try { await api.zcodeDisconnect(); await load(); onChanged && onChanged() } catch (e) { setError(String((e && e.message) || e)) } finally { setPending(false) }
      }
      let body = null
      if (!st) body = h('div', { className: 'dmu-muted' }, tr('loading'))
      else if (st.connected) {
        body = h('div', null,
          h('div', { className: 'dmu-cap' }, '✓ ' + tr('srcZcodeApp')),
          h('div', { className: 'dmu-cap' }, tr('sharedNote')),
          h('div', { className: 'dmu-dialog-actions' },
            h('button', { className: 'dmu-btn', onClick: disconnect, disabled: pending }, tr('disconnect'))))
      } else if (login) {
        body = h('div', null,
          h('div', { className: 'dmu-cap' }, tr('loginGuide')),
          h('textarea', { className: 'dmu-input', rows: 3, value: input, placeholder: 'zcode://oauth/callback?code=…', onInput: (e) => setInput(e.target.value) }),
          h('div', { className: 'dmu-dialog-actions' },
            h('button', { className: 'dmu-btn', onClick: () => setLogin(null), disabled: pending }, tr('cancel')),
            h('button', { className: 'dmu-btn dmu-btn-primary', onClick: finish, disabled: pending || !input.trim() }, pending ? tr('loading') : tr('loginDone'))))
      } else {
        body = h('div', null,
          h('div', { className: 'dmu-cap' }, tr('notConnected')),
          h('div', { className: 'dmu-dialog-actions' },
            h('button', { className: 'dmu-btn dmu-btn-primary', onClick: start, disabled: pending }, tr('loginGo'))))
      }
      return h('div', { className: 'dmu-overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'dmu-dialog', role: 'dialog', 'aria-label': tr('account') },
          h('div', { className: 'dmu-dialog-head' },
            h('span', { className: 'dmu-dialog-title' }, tr('account')),
            h('button', { className: 'dmu-iconbtn dmu-headbtn', title: tr('close'), 'aria-label': tr('close'), onClick: onClose }, h(IcoX))),
          body,
          error ? h('div', { className: 'dmu-err' }, error) : null))
    }

    // ---------------------------------------------------------------- 官方价格校验
    // Host 每 12h 抓一次官方定价页并与本地 pricing 配置比对；出现差异时弹窗提醒改配置。
    const DRIFT_STORE_KEY = 'dmu:pricingdrift'
    function driftFingerprint(drift) {
      try {
        return JSON.stringify((drift || []).map((d) => [d && d.field, String(d && d.config), String(d && d.official)]))
      } catch { return '' }
    }
    function usePricingDrift(api) {
      const [check, setCheck] = useState(null)
      const [seen, setSeen] = useState(() => { try { return window.localStorage.getItem(DRIFT_STORE_KEY) || '' } catch { return '' } })
      useEffect(() => {
        let alive = true
        const load = () => api.pricingCheck()
          .then((v) => { if (alive && v) setCheck(v) })
          .catch(() => {})
        const first = setTimeout(load, 1500) // 让首屏额度请求先跑，避免抢带宽
        const timer = setInterval(load, 6 * 3600 * 1000)
        return () => { alive = false; clearTimeout(first); clearInterval(timer) }
      }, [api])
      const drift = check && Array.isArray(check.drift) ? check.drift : []
      const fp = drift.length ? driftFingerprint(drift) : ''
      const dismiss = () => {
        setSeen(fp)
        try { window.localStorage.setItem(DRIFT_STORE_KEY, fp) } catch {}
      }
      return { check, drift, show: !!fp && fp !== seen, dismiss }
    }

    /** 官方价格表漂移提醒弹窗：列出配置值与官方值，关闭后记住指纹不再打扰。 */
    function PricingDriftDialog({ drift, checkedAt, tr, onClose }) {
      return h('div', { className: 'dmu-overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'dmu-dialog', role: 'dialog', 'aria-label': tr('pricingDriftTitle') },
          h('div', { className: 'dmu-dialog-head' },
            h('span', { className: 'dmu-dialog-title' }, tr('pricingDriftTitle')),
            h('button', { className: 'dmu-iconbtn dmu-headbtn', title: tr('close'), 'aria-label': tr('close'), onClick: onClose }, h(IcoX))),
          h('div', { className: 'dmu-cap' }, tr('pricingDriftBody')),
          h('div', { className: 'dmu-drift' },
            h('div', { className: 'dmu-drift-head' },
              h('span', null, tr('pricingDriftField')),
              h('span', null, tr('pricingDriftConfig')),
              h('span', null, tr('pricingDriftOfficial'))),
            drift.map((d, i) => h('div', { className: 'dmu-drift-row', key: i },
              h('span', { className: 'f' }, String((d && d.field) || '')),
              h('span', { className: 'c' }, String(d && d.config != null ? d.config : '—')),
              h('span', { className: 'o' }, String(d && d.official != null ? d.official : '—'))))),
          checkedAt ? h('div', { className: 'dmu-cap' }, tr('pricingDriftChecked') + '：' + new Date(checkedAt).toLocaleString()) : null,
          h('div', { className: 'dmu-dialog-actions' },
            h('button', { className: 'dmu-btn dmu-btn-primary', onClick: onClose }, tr('pricingDriftGotIt')))))
    }

    // ---------------------------------------------------------------- 侧栏入口
    // DSH 侧栏左下角的账号菜单向上弹出时会覆盖本插件的供应商卡片：菜单打开期间隐藏卡片，
    // 关闭后立即恢复，避免卡片干扰菜单显示。账号菜单 trigger 由侧栏 settings.launcher 渲染，
    // 独有标记为 data-signed-out + aria-haspopup="menu"，开合状态反映在其 aria-expanded 上；
    // 用 MutationObserver 跟随属性变化（不轮询）。隐藏交给 CSS 的 visibility（保留占位），
    // 否则侧栏底部布局收缩会让菜单与触发按钮错位。
    const ACCOUNT_MENU_OPEN = 'button[data-signed-out][aria-haspopup="menu"][aria-expanded="true"]'
    const useAccountMenuOpen = () => {
      const [open, setOpen] = useState(false)
      useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return
        const sync = () => setOpen(document.querySelector(ACCOUNT_MENU_OPEN) !== null)
        sync()
        // 用宿主 window 上的 MutationObserver（与非浏览器测试环境兼容）
        if (typeof window.MutationObserver !== 'function') return
        const mo = new window.MutationObserver(sync)
        mo.observe(document.body, { attributes: true, attributeFilter: ['aria-expanded'], subtree: true })
        return () => mo.disconnect()
      }, [])
      return open
    }

    function FooterEntry(props) {
      const { api, sel } = props
      const tr = trWith(props.t)
      const { snap, isBusy, refresh } = useSnapshot(api)
      const menuOpen = useAccountMenuOpen()
      const pricingEnv = usePricingEnv(api)
      const driftBox = usePricingDrift(api)
      const [open, setOpen] = useState(false)
      const [accountRoute, setAccountRoute] = useState(null)
      const [resetTarget, setResetTarget] = useState(null) // { route, provider }
      const currentRoute = sel
      const providers = ((snap && snap.providers) || []).filter((p) => p.status !== 'idle')
      const template = (snap && snap.card && snap.card.template) || ''
      const current = (currentRoute && providers.find((p) => p.route === currentRoute)) || null
      // 未识别当前会话供应商时，展示状态最紧急的一个
      const worst = providers.slice().sort((a, b) => ({ error: 2, warn: 1, ok: 0, idle: -1 }[stateOf(b)] - { error: 2, warn: 1, ok: 0, idle: -1 }[stateOf(a)]))[0]
      const shown = current || worst
      // 峰谷状态（DeepSeek 官方计费）：大数字配色 + 充值行倒计时，侧栏与弹窗左列共用
      const peakState = usePeakState(pricingEnv)
      // 首次快照尚未返回（DSH 冷启动、Host 仍在查各供应商额度）：先摆出骨架卡片，
      // 避免侧栏底部空白等待；快照已回但无可用供应商（无额度接口）时照旧隐藏。
      if (!shown) {
        if (snap) return null
        return props.wide === false
          ? h('button', { type: 'button', className: 'dmu-foot dmu-foot-compact dmu-ghost', disabled: true, title: tr('loading'), 'aria-label': tr('loading'), 'data-account-menu-open': menuOpen ? '' : undefined },
              h('span', { className: 'dmu-ghost-circle dmu-ghost-circle-sm' }))
          : h('div', { className: 'dmu-footwrap', 'data-account-menu-open': menuOpen ? '' : undefined },
              h('div', { className: 'dmu-pcard dmu-pcard-ghost', title: tr('loading'), 'aria-label': tr('loading') },
                h('div', { className: 'dmu-ghost-row' },
                  h('span', { className: 'dmu-ghost-circle' }),
                  h('span', { className: 'dmu-ghost-line' })),
                h('span', { className: 'dmu-ghost-line dmu-ghost-line-sm' })))
      }
      const openModal = () => setOpen(true)
      const onAccount = (route) => setAccountRoute(route)
      // 打开「可重置额度」弹窗：携带该供应商完整快照（窗口 + 重置机会）
      const onResetWindow = (route) => {
        const provider = providers.find((x) => x.route === route)
        if (provider) setResetTarget({ route, provider })
      }
      const dialogs = [
        driftBox.show ? h(PricingDriftDialog, {
          key: 'drift', drift: driftBox.drift, tr,
          checkedAt: driftBox.check && driftBox.check.checkedAt,
          onClose: driftBox.dismiss,
        }) : null,
        accountRoute ? h(AccountDialog, { key: 'acct', api, tr, onClose: () => setAccountRoute(null), onChanged: () => refresh(accountRoute) }) : null,
        resetTarget ? h(ResetQuotaDialog, {
          key: 'reset', api, tr, p: resetTarget.provider,
          onClose: () => setResetTarget(null),
          onDone: () => { const r = resetTarget.route; setResetTarget(null); refresh(r) },
        }) : null,
      ]
      const modalProps = { api, snap, isBusy, refresh, tr, sessionName: props.sessionName, onAccount, onResetWindow, peakState }
      if (props.wide === false) {
        return h(React.Fragment, null,
          h('button', { className: 'dmu-foot dmu-foot-compact', title: (shown.displayName || shown.route), 'data-account-menu-open': menuOpen ? '' : undefined, onClick: openModal },
            h(Logo, { p: shown, size: 18 }), h(Dot, { state: stateOf(shown) })),
          open ? h(UsageModal, { ...modalProps, onClose: () => setOpen(false) }) : null,
          dialogs)
      }
      return h(React.Fragment, null,
        h('div', { className: 'dmu-footwrap', 'data-account-menu-open': menuOpen ? '' : undefined },
          h(ProviderCard, { p: shown, tr, template, busy: isBusy(shown.route), onRefresh: refresh, onOpen: openModal, onAccount, onResetWindow, peakState })),
        open ? h(UsageModal, { ...modalProps, onClose: () => setOpen(false) }) : null,
        dialogs)
    }

    // ---------------------------------------------------------------- apply
    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const api = createApi()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dmu: locale')
        ctx.effect(() => {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = 'model-usage/style.css'
          link.id = 'dsh-model-usage-style'
          document.head.appendChild(link)
          return () => link.remove()
        }, 'dmu: styles')
        // 会话 id → 对话名称（经 sessions 服务实时解析；取不到时展示完整 id，
        // 不在数据层截断——溢出由 CSS 按字符断行处理）
        const sessionName = (id) => {
          if (!id) return ''
          try {
            const list = ctx.sessions && ctx.sessions.list
            const snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
            const row = snap && snap.byId && snap.byId[id]
            const t = row && (row.title || row.name || row.displayName || row.label)
            if (typeof t === 'string' && t.trim()) return t
          } catch { /* 会话服务不可用 */ }
          return id
        }
        // 当前前台对话供应商选择器：会话 modelSelection 投影 + Host 最近活跃兜底
        const sel = { route: null, listeners: new Set() }
        const emit = (r) => { if (r && r !== sel.route) { sel.route = r; for (const l of [...sel.listeners]) { try { l(r) } catch {} } } }
        const useSel = () => {
          const [r, setR] = useState(sel.route)
          useEffect(() => { const l = (v) => setR(v); sel.listeners.add(l); return () => sel.listeners.delete(l) }, [])
          return r
        }
        ctx.effect(() => {
          return trackCurrentRoute(ctx, api, emit)
        }, 'dmu: selection')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: '@antecer/dsh-model-usage',
          order: -2,
          locale: NS,
          inject: () => ({ api, useSel, sessionName }),
        }, FooterEntryWithSel))
      },
    }

    // 包装：把 useSel hook 接入组件 props
    function FooterEntryWithSel(props) {
      const currentRoute = props.useSel()
      return h(FooterEntry, { ...props, sel: currentRoute })
    }
  },
})
