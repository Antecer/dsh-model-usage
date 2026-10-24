// dsh-model-usage · 定价与节假日
// 职责：DeepSeek 官方峰谷规则与单价的默认配置、官方定价页解析与配置漂移校验、
// 中国法定节假日表（第三方免费 API：timor.tech，仅用于判断节假日全天空闲）。
// 网络访问集中在 createPricingService（可注入 fetch/now 便于测试），解析与对比均为纯函数。

/** 官方当前定价（元 / 百万 tokens）。峰谷窗口与星期可被 cordis.patch.yml 的 pricing 覆盖。 */
export const PRICING_DEFAULTS = {
  peakDays: [1, 2, 3, 4, 5], // 周一至周五
  peakWindows: [['09:00', '12:00'], ['14:00', '18:00']], // 北京时间
  models: {
    'deepseek-flash': {
      cacheHit: { peak: 0.04, offPeak: 0.02 },
      cacheMiss: { peak: 2, offPeak: 1 },
      output: { peak: 8, offPeak: 4 },
    },
    'deepseek-v4-pro': {
      cacheHit: { peak: 0.3, offPeak: 0.15 },
      cacheMiss: { peak: 9, offPeak: 4.5 },
      output: { peak: 27, offPeak: 13.5 },
    },
  },
}

export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
export const HOLIDAY_URL = (year) => `https://timor.tech/api/holiday/year/${year}`

const safe = (e) => String((e && e.message) || e)
/** 规范化为 HH:MM（官方页面写 9:00，配置写 09:00，比较前必须统一）。 */
const normHM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim())
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : String(s == null ? '' : s)
}

/** 去掉标签/脚本并压缩空白，得到可正则解析的纯文本。 */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析官方中文定价页文本，返回 { models, peakWindows, peakDays } 或 { error }。
 * 只认中文页（人民币报价，与配置同单位）；页面改版导致解析失败时返回 error，绝不猜价格。
 */
export function parseOfficialPricing(html) {
  const text = stripHtml(html)
  const hitIdx = text.indexOf('缓存命中')
  const missIdx = text.indexOf('缓存未命中', hitIdx + 1)
  const outIdx = text.indexOf('百万tokens输出', missIdx + 1)
  const concIdx = text.indexOf('并发限制', outIdx + 1)
  const seg = (from, to) => (from >= 0 && (to < 0 || to > from) ? text.slice(from, to < 0 ? undefined : to) : '')
  const priceRe = /空闲时段\s+([\d.]+)元\s+([\d.]+)元\s*高峰时段\s+([\d.]+)元\s+([\d.]+)元/
  const hit = priceRe.exec(seg(hitIdx, missIdx))
  const miss = priceRe.exec(seg(missIdx, outIdx))
  const out = priceRe.exec(seg(outIdx, concIdx))
  const names = /模型\s+(deepseek-[a-z0-9.-]+)\s*(?:\(\d+\))?\s*(deepseek-[a-z0-9.-]+)/i.exec(text)
  const win = /北京时间周一至周五（不含中国法定节假日）\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})、(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(text)
  if (!hit || !miss || !out || !names || !win) {
    return { error: '无法从官方定价页解析价格表（页面结构可能已变化）' }
  }
  const [flash, pro] = [names[1], names[2]]
  const models = {}
  models[flash] = {
    cacheHit: { offPeak: Number(hit[1]), peak: Number(hit[3]) },
    cacheMiss: { offPeak: Number(miss[1]), peak: Number(miss[3]) },
    output: { offPeak: Number(out[1]), peak: Number(out[3]) },
  }
  models[pro] = {
    cacheHit: { offPeak: Number(hit[2]), peak: Number(hit[4]) },
    cacheMiss: { offPeak: Number(miss[2]), peak: Number(miss[4]) },
    output: { offPeak: Number(out[2]), peak: Number(out[4]) },
  }
  return {
    models,
    peakWindows: [[normHM(win[1]), normHM(win[2])], [normHM(win[3]), normHM(win[4])]],
    peakDays: [1, 2, 3, 4, 5],
    source: PRICING_URL,
  }
}

/** 从 timor.tech 年度响应里取「放假」日期（holiday === true）；补班日不算节假日。 */
export function parseHolidayYear(json, year) {
  const days = []
  const holiday = json && json.holiday
  if (!holiday || typeof holiday !== 'object') return days
  for (const v of Object.values(holiday)) {
    if (!v || v.holiday !== true) continue
    const date = typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : null
    if (date && (!year || date.startsWith(String(year) + '-'))) days.push(date)
  }
  return days.sort()
}

const normWindows = (ws) => (Array.isArray(ws) ? ws : [])
  .map((w) => (Array.isArray(w) ? normHM(w[0]) + '-' + normHM(w[1]) : String(w)))
  .join(',')

/**
 * 对比配置价格与官方解析结果，返回差异列表（空数组 = 一致）。
 * field 使用配置路径（models.<模型>.<项>.<时段> / peakWindows / peakDays），便于弹窗直接展示。
 */
export function diffPricing(configPricing, official) {
  const drift = []
  const cfg = configPricing || PRICING_DEFAULTS
  const models = (official && official.models) || {}
  const cfgModels = cfg.models || {}
  for (const [name, off] of Object.entries(models)) {
    const cur = cfgModels[name]
    if (!cur) {
      drift.push({ field: 'models.' + name, config: '未配置', official: '官方有此模型' })
      continue
    }
    for (const kind of ['cacheHit', 'cacheMiss', 'output']) {
      for (const phase of ['peak', 'offPeak']) {
        const c = Number(cur[kind] && cur[kind][phase])
        const o = Number(off[kind] && off[kind][phase])
        if (!Number.isFinite(o)) continue
        if (!Number.isFinite(c) || Math.abs(c - o) > 1e-9) {
          drift.push({ field: `models.${name}.${kind}.${phase}`, config: Number.isFinite(c) ? c : null, official: o })
        }
      }
    }
  }
  for (const name of Object.keys(cfgModels)) {
    if (!models[name]) drift.push({ field: 'models.' + name, config: '已配置', official: '官方已无此模型' })
  }
  if (official && Array.isArray(official.peakWindows) && normWindows(cfg.peakWindows) !== normWindows(official.peakWindows)) {
    drift.push({ field: 'peakWindows', config: normWindows(cfg.peakWindows), official: normWindows(official.peakWindows) })
  }
  if (official && Array.isArray(official.peakDays) && (cfg.peakDays || []).join(',') !== official.peakDays.join(',')) {
    drift.push({ field: 'peakDays', config: (cfg.peakDays || []).join(','), official: official.peakDays.join(',') })
  }
  return drift
}

/**
 * 定价/节假日服务：节假日表 24h 缓存，官方价格校验 12h 缓存；失败只记录错误，不误报变动。
 * @param {{ pricing?: object }} config 已合并默认值的配置（读取 config.pricing）
 * @param {{ fetch?: Function, now?: () => number, holidayTtl?: number, checkTtl?: number }} [opts] 测试注入
 */
export function createPricingService(config, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch
  const now = opts.now || (() => Date.now())
  const holidayTtl = opts.holidayTtl ?? 24 * 3600 * 1000
  const checkTtl = opts.checkTtl ?? 12 * 3600 * 1000
  let holidayBox = { at: 0, days: [], years: [], error: null, inflight: null }
  let checkBox = { at: 0, result: null, inflight: null }

  async function request(url, asJson, ms) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ms)
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-model-usage' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return asJson ? await res.json() : await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  async function loadHolidays() {
    const year = new Date(now() + 8 * 3600e3).getUTCFullYear()
    const years = [year, year + 1]
    let error = null
    // 两年并行拉取；下一年数据尚未发布是常态，失败静默降级为仅周末规则
    const lists = await Promise.all(years.map(async (y) => {
      try {
        return parseHolidayYear(await request(HOLIDAY_URL(y), true, 8000), y)
      } catch (e) {
        if (!error) error = safe(e)
        return []
      }
    }))
    return { at: now(), days: [...new Set(lists.flat())].sort(), years, error }
  }

  async function getHolidays(force) {
    if (!force && holidayBox.at && now() - holidayBox.at < holidayTtl) {
      return { days: holidayBox.days, years: holidayBox.years, error: holidayBox.error }
    }
    if (holidayBox.inflight) return holidayBox.inflight
    holidayBox.inflight = loadHolidays()
      .catch((e) => ({ at: now(), days: holidayBox.days || [], years: holidayBox.years || [], error: safe(e) }))
      .then((r) => {
        holidayBox = { ...holidayBox, at: r.at, days: r.days, years: r.years, error: r.error, inflight: null }
        return r
      })
      .finally(() => { holidayBox.inflight = null })
    return holidayBox.inflight
  }

  async function loadCheck() {
    try {
      const html = await request(PRICING_URL, false, 12000)
      const official = parseOfficialPricing(html)
      if (official.error) return { checkedAt: now(), ok: false, error: official.error, drift: [] }
      const drift = diffPricing(config.pricing || PRICING_DEFAULTS, official)
      return { checkedAt: now(), ok: true, drift, source: official.source }
    } catch (e) {
      return { checkedAt: now(), ok: false, error: safe(e), drift: [] }
    }
  }

  async function checkOfficial(force) {
    if (!force && checkBox.at && now() - checkBox.at < checkTtl && checkBox.result) return checkBox.result
    if (checkBox.inflight) return checkBox.inflight
    checkBox.inflight = loadCheck()
      .then((r) => {
        checkBox = { at: r.checkedAt, result: r, inflight: null }
        return r
      })
      .finally(() => { checkBox.inflight = null })
    return checkBox.inflight
  }

  return { getHolidays, checkOfficial }
}
