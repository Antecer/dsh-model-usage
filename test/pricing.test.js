import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRICING_DEFAULTS,
  parseOfficialPricing,
  parseHolidayYear,
  diffPricing,
  createPricingService,
  stripHtml,
} from '../lib/pricing.mjs'

// ---------------------------------------------------------------- 夹具
// 官方中文定价页关键片段（真实页面的精简版，用于离线回归解析逻辑）
const OFFICIAL_HTML = `<html><body>
<p>模型 deepseek-flash (1) deepseek-v4-pro</p>
<p>价格 (2)</p>
<p>百万tokens输入 （缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元</p>
<p>百万tokens输入 （缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元</p>
<p>百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元</p>
<p>并发限制 (3) 2500 500</p>
<p>(2) 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。</p>
</body></html>`

const HOLIDAY_2026 = {
  code: 0,
  holiday: {
    '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
    '01-04': { holiday: false, name: '元旦后补班', date: '2026-01-04' },
    '02-15': { holiday: true, name: '春节', date: '2026-02-15' },
    '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
  },
}

/** 可区分 URL 的 fetch 替身；calls 记录请求次数。 */
function fakeFetch(routes, opts = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    if (opts.fail) throw new Error(opts.fail)
    for (const [key, value] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        return {
          ok: true,
          status: 200,
          async text() { return value.text || '' },
          async json() { return value.json },
        }
      }
    }
    return { ok: false, status: 404, async text() { return '' }, async json() { return {} } }
  }
  impl.calls = calls
  return impl
}

// ---------------------------------------------------------------- 解析
test('官方定价页解析：两个模型 × 峰/谷三档价格 + 高峰窗口', () => {
  const p = parseOfficialPricing(OFFICIAL_HTML)
  assert.ok(!p.error, '应成功解析：' + (p.error || ''))
  assert.deepEqual(p.peakWindows, [['09:00', '12:00'], ['14:00', '18:00']], '窗口应规范化为 HH:MM')
  assert.deepEqual(p.peakDays, [1, 2, 3, 4, 5])
  assert.deepEqual(p.models['deepseek-flash'], {
    cacheHit: { offPeak: 0.02, peak: 0.04 },
    cacheMiss: { offPeak: 1, peak: 2 },
    output: { offPeak: 4, peak: 8 },
  })
  assert.deepEqual(p.models['deepseek-v4-pro'].output, { offPeak: 13.5, peak: 27 })
})

test('官方定价页解析失败：缺价格表结构时返回 error，不猜价格', () => {
  assert.ok(parseOfficialPricing('<html><body>页面改版了</body></html>').error)
  assert.ok(parseOfficialPricing('').error)
})

test('stripHtml：去标签与脚本、压缩空白', () => {
  const text = stripHtml('<div>a<script>x</script><b>b</b>&nbsp; c</div>')
  assert.equal(text, 'a b c')
})

// ---------------------------------------------------------------- 节假日
test('节假日解析：只取 holiday=true 的日期，补班日不算节假日', () => {
  const days = parseHolidayYear(HOLIDAY_2026, 2026)
  assert.deepEqual(days, ['2026-01-01', '2026-02-15', '2026-10-01'])
  assert.deepEqual(parseHolidayYear({ code: 0, holiday: {} }, 2027), [], '未发布的年份应为空')
  assert.deepEqual(parseHolidayYear(null, 2026), [])
})

// ---------------------------------------------------------------- 漂移对比
test('漂移对比：默认配置与官方一致时无差异', () => {
  assert.deepEqual(diffPricing(PRICING_DEFAULTS, parseOfficialPricing(OFFICIAL_HTML)), [])
})

test('漂移对比：价格、窗口、模型缺失都会列出配置路径', () => {
  const cfg = JSON.parse(JSON.stringify(PRICING_DEFAULTS))
  cfg.models['deepseek-flash'].output.peak = 9
  cfg.peakWindows = [['10:00', '12:00'], ['14:00', '18:00']]
  delete cfg.models['deepseek-v4-pro']
  const drift = diffPricing(cfg, parseOfficialPricing(OFFICIAL_HTML))
  const fields = drift.map((d) => d.field)
  assert.ok(fields.includes('models.deepseek-flash.output.peak'), '价格差异应列出')
  assert.ok(fields.includes('peakWindows'), '窗口差异应列出')
  assert.ok(fields.includes('models.deepseek-v4-pro'), '未配置的官方模型应列出')
  const row = drift.find((d) => d.field === 'models.deepseek-flash.output.peak')
  assert.equal(row.config, 9)
  assert.equal(row.official, 8)
})

// ---------------------------------------------------------------- 服务
test('节假日服务：拉取当年与下一年，按 URL 缓存 24h', async () => {
  const fetchImpl = fakeFetch({
    'holiday/year/2026': { json: HOLIDAY_2026 },
    'holiday/year/2027': { json: { code: 0, holiday: {} } },
  })
  const svc = createPricingService({ pricing: PRICING_DEFAULTS }, { fetch: fetchImpl, now: () => Date.UTC(2026, 9, 24, 4, 0) })
  const a = await svc.getHolidays()
  assert.deepEqual(a.days, ['2026-01-01', '2026-02-15', '2026-10-01'])
  assert.deepEqual(a.years, [2026, 2027])
  const before = fetchImpl.calls.length
  const b = await svc.getHolidays()
  assert.equal(fetchImpl.calls.length, before, 'TTL 内不应重复请求')
  assert.deepEqual(b.days, a.days)
})

test('价格校验：默认配置与官方一致 → 无漂移；12h 内复用缓存', async () => {
  const fetchImpl = fakeFetch({ 'quick_start/pricing': { text: OFFICIAL_HTML } })
  const svc = createPricingService({ pricing: PRICING_DEFAULTS }, { fetch: fetchImpl, now: () => Date.UTC(2026, 9, 24, 4, 0) })
  const r = await svc.checkOfficial()
  assert.equal(r.ok, true)
  assert.deepEqual(r.drift, [])
  const before = fetchImpl.calls.length
  await svc.checkOfficial()
  assert.equal(fetchImpl.calls.length, before, '12h 内应命中缓存')
})

test('价格校验：官方价格变动时报出差异；抓取失败返回 ok=false 不误报', async () => {
  const changed = OFFICIAL_HTML.replace('高峰时段 8元 27.0元', '高峰时段 9元 27.0元')
  const okFetch = fakeFetch({ 'quick_start/pricing': { text: changed } })
  const svc = createPricingService({ pricing: PRICING_DEFAULTS }, { fetch: okFetch, now: () => Date.UTC(2026, 9, 24, 4, 0) })
  const r = await svc.checkOfficial()
  assert.equal(r.ok, true)
  assert.deepEqual(r.drift, [{ field: 'models.deepseek-flash.output.peak', config: 8, official: 9 }])

  const badFetch = fakeFetch({}, { fail: 'network down' })
  const svc2 = createPricingService({ pricing: PRICING_DEFAULTS }, { fetch: badFetch, now: () => Date.UTC(2026, 9, 24, 4, 0) })
  const bad = await svc2.checkOfficial()
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.drift, [], '解析/网络失败不得产生差异（避免误弹窗）')
  assert.match(bad.error, /network down/)
})
