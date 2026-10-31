import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.mjs'
import { adapterFor } from '../lib/adapters.mjs'
import { invalidateProfileCache } from '../lib/profile.mjs'

function harness(config, providers, keys, optionalServices) {
  let handler
  const events = new Map()
  const resolved = []
  const ctx = {
    effect(fn, label) { if (label !== 'model-usage: ledger') fn() },
    on(name, fn) { events.set(name, fn); return () => {} },
    get(name) { return optionalServices?.[name] ?? null },
    inject(deps, fn) {
      if (optionalServices && deps.some((name) => !['llm', 'credentials', 'connection', 'webServer'].includes(name))) return
      fn(this)
    },
    llm: { listProviders: () => providers.map((id) => ({ id })) },
    credentials: { async resolve(ref) { resolved.push(ref); return keys[ref] ? { value: keys[ref] } : null } },
    connection: { admit: () => ({}) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  if (optionalServices) {
    for (const name of ['profileContext', 'agents', 'sessionController']) {
      Object.defineProperty(ctx, name, { get() { throw new Error('cannot get property without inject: ' + name) } })
    }
  }
  apply(ctx, { sessionResolver: async () => null, ...config })
  return {
    resolved,
    events,
    async snapshot() {
      const req = new EventEmitter()
      req.method = 'POST'
      const response = new Promise((resolve) => {
        handler(req, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
      })
      req.emit('data', Buffer.from(JSON.stringify({ endpoint: 'snapshot' })))
      req.emit('end')
      const result = await response
      assert.equal(result.ok, true)
      return result.value
    },
  }
}

const kimiReply = { usage: { limit: 100, used: 25 }, user: { membership: { level: 'LEVEL_PRO' } } }

function fixture(t, reply = kimiReply) {
  const prevDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = fileURLToPath(new URL('./fixtures/profile', import.meta.url))
  invalidateProfileCache()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, authorization: init.headers.authorization })
    return { ok: true, status: 200, async json() { return reply } }
  })
  t.after(() => {
    if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prevDir
    invalidateProfileCache()
  })
  return requests
}

test('自定义 Kimi 路由无需 credentials/adapters 配置，各自复用 provider 凭据', async (t) => {
  const requests = fixture(t)
  const host = harness({}, ['kimi1', 'kimi2'], {
    MODEL_USAGE_TEST_KIMI1: 'test-account-one',
    MODEL_USAGE_TEST_KIMI2: 'test-account-two',
    KIMI_API_KEY: 'test-unrelated-default',
  })
  const snapshot = await host.snapshot()
  assert.deepEqual(snapshot.providers.map((p) => [p.route, p.adapter, p.status]), [
    ['kimi1', 'kimi-coding', 'ok'], ['kimi2', 'kimi-coding', 'ok'],
  ])
  assert.deepEqual(requests, [
    { url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer test-account-one' },
    { url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer test-account-two' },
  ])
  assert.ok(!JSON.stringify(snapshot).includes('test-account'))
})

test('Kimi 周窗口：used=0 时接口省略 used 字段，仍应显示 0% 周窗口', async (t) => {
  // 实测 Kimi 在周用量为 0 时只返回 limit/remaining/resetTime（没有 used）；
  // 旧逻辑要求 used != null 才渲染，导致「周」整行消失、看起来像没有周额度。
  const reply = {
    usage: { limit: 100, remaining: 100, resetTime: '2026-10-31T05:31:12.713215Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: 100, resetTime: '2026-10-24T09:31:12.713215Z' } }],
  }
  fixture(t, reply)
  const host = harness({ adapters: { kimi1: 'kimi-coding' } }, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-key' })
  const snapshot = await host.snapshot()
  const p = snapshot.providers[0]
  assert.equal(p.status, 'ok')
  const weekly = p.windows.find((w) => w.key === 'weekly')
  assert.ok(weekly, '未使用时也应显示周窗口')
  assert.equal(weekly.usedPct, 0, '未使用应为 0%')
  assert.ok(p.windows.find((w) => w.key === 'rolling'), '5h 滚动窗口也应显示')
})

test('Kimi 月度配额账号：无 usage 汇总时按 usages.limit_month_total 显示月窗口', async (t) => {
  // 实测「Kimi备用」这类月度配额账号：接口不返回 usage（周汇总），
  // 只在 usages 里给 limit_5h 与 limit_month_total / limit_month_code。
  const reply = {
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, used: 48, remaining: 52, resetTime: '2026-10-26T13:04:39.015764Z' } }],
    usages: {
      limit_5h: { used_ratio: 0.4763, reset_time: '2026-10-26T13:04:38Z' },
      limit_month_total: { used_ratio: 0.2561, reset_time: '2026-11-23T00:00:00Z' },
      limit_month_code: { used_ratio: 0.2561, reset_time: '2026-11-23T00:00:00Z' },
    },
  }
  fixture(t, reply)
  const host = harness({ adapters: { kimi1: 'kimi-coding' } }, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-key' })
  const p = (await host.snapshot()).providers[0]
  assert.equal(p.status, 'ok')
  const monthly = p.windows.find((w) => w.key === 'monthly')
  assert.ok(monthly, '月度配额账号应显示月窗口')
  assert.equal(monthly.label, '月')
  assert.ok(Math.abs(monthly.usedPct - 25.61) < 0.01, '月用量比例应取自 used_ratio')
  assert.ok(!p.windows.some((w) => w.key === 'weekly'), '月度套餐不应凭空出现周窗口')
  assert.ok(p.windows.find((w) => w.key === 'rolling'), '5h 滚动窗口仍应显示')
})

test('Kimi 周汇总缺失但 usages.limit_7d 存在时，用 usages 兜底周窗口', async (t) => {
  fixture(t, { usages: { limit_7d: { used_ratio: 0.42, reset_time: '2026-10-29T02:54:46Z' } } })
  const host = harness({ adapters: { kimi1: 'kimi-coding' } }, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-key' })
  const weekly = (await host.snapshot()).providers[0].windows.find((w) => w.key === 'weekly')
  assert.ok(weekly, 'usage 缺失时应由 usages.limit_7d 兜底出周窗口')
  assert.ok(Math.abs(weekly.usedPct - 42) < 0.01, '周用量比例应取自 used_ratio')
})

test('显式 adapters 仅选查询模板，不必重复指定 provider 凭据', async (t) => {
  const requests = fixture(t)
  const host = harness({ adapters: { kimi1: 'kimi-coding' } }, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-own-key' })
  assert.equal((await host.snapshot()).providers[0].status, 'ok')
  assert.equal(requests[0].authorization, 'Bearer test-own-key')
})

test('provider 凭据缺失时不回退到另一个账号的默认凭据', async (t) => {
  const requests = fixture(t)
  const host = harness({ adapters: { kimi1: 'kimi-coding' } }, ['kimi1'], { KIMI_CODING_API_KEY: 'test-wrong-account' })
  assert.equal((await host.snapshot()).providers[0].status, 'needs-credential')
  assert.deepEqual(requests, [])
})

test('credentials 显式覆盖仍然有效', async (t) => {
  const requests = fixture(t)
  const host = harness({ adapters: { kimi1: 'kimi-coding' }, credentials: { kimi1: 'TEST_OVERRIDE' } }, ['kimi1'], {
    TEST_OVERRIDE: 'test-override', MODEL_USAGE_TEST_KIMI1: 'test-provider',
  })
  assert.equal((await host.snapshot()).providers[0].status, 'ok')
  assert.equal(requests[0].authorization, 'Bearer test-override')
})

test('URL 识别优先于路由名，精确匹配主机及 Kimi Coding 路径', () => {
  assert.equal(adapterFor('custom', {}, { baseURL: 'https://api.kimi.com/coding/v1/' })?.id, 'kimi-coding')
  assert.equal(adapterFor('kimi1', {}, { baseURL: 'https://openrouter.ai/api/v1' })?.id, 'openrouter')
  assert.equal(adapterFor('kimi1', {}, { baseURL: 'https://api.kimi.com.evil.example/coding/v1' }), null)
  assert.equal(adapterFor('kimi1', {}, { baseURL: 'https://api.kimi.com/other' }), null)
  assert.equal(adapterFor('kimi1', {}, { baseURL: 'invalid' }), null)
  assert.equal(adapterFor('kimi-coding', {})?.id, 'kimi-coding')
  assert.equal(adapterFor('custom', { adapters: { custom: 'kimi-coding' } })?.id, 'kimi-coding')
})

test('无 baseURL 的自定义 kimi 路由不被猜测为 moonshot（key 不外发）', async (t) => {
  // DSH 内置列表只有 kimi-coding 与 moonshotai，自定义 kimi* 路由必然有 baseURL；
  // profile 读不到时必须隐藏，而不是跌回路由名猜测把 key 发往 moonshot 域名
  const prevDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = fileURLToPath(new URL('./fixtures/profile-empty', import.meta.url))
  invalidateProfileCache()
  t.after(() => {
    if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prevDir
    invalidateProfileCache()
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, authorization: init.headers.authorization })
    return { ok: true, status: 200, async json() { return kimiReply } }
  })
  const host = harness({}, ['kimi1', 'kimi2'], {
    KIMI_API_KEY: 'test-should-not-leave-host',
    MOONSHOT_API_KEY: 'test-should-not-leave-host',
  })
  const snap = await host.snapshot()
  assert.deepEqual(snap.providers, [], '无 baseURL 的自定义 kimi 路由应隐藏而非猜测')
  assert.deepEqual(requests, [], '任何情况下都不应向猜测的域名发出请求')
})

test('GLM 重置时间：秒级时间戳/ISO 字符串/缺失（MCP 按次月 1 日 UTC 补算）', async (t) => {
  const prevDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = fileURLToPath(new URL('./fixtures/profile-empty', import.meta.url))
  invalidateProfileCache()
  t.after(() => {
    if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prevDir
    invalidateProfileCache()
  })
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200,
    async json() {
      return {
        data: {
          level: 'pro',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, percentage: 15, nextResetTime: 1770648402 }, // 秒级时间戳
            { type: 'TOKENS_LIMIT', unit: 6, percentage: 45, nextResetTime: '2026-10-30T00:00:00.000Z' }, // ISO 字符串
            { type: 'TIME_LIMIT', unit: 5, percentage: 10, usage: 100, remaining: 90 }, // 无 nextResetTime
          ],
        },
      }
    },
  }))
  const host = harness({}, ['zai-coding-cn'], { ZAI_CODING_CN_API_KEY: 'test-glm' })
  const p = (await host.snapshot()).providers[0]
  assert.equal(p.adapter, 'glm-coding')
  assert.equal(p.status, 'ok')
  const byKey = Object.fromEntries(p.windows.map((w) => [w.key, w]))
  assert.equal(byKey.rolling.resetAt, 1770648402 * 1000, '秒级时间戳应转毫秒')
  assert.equal(byKey.weekly.resetAt, Date.parse('2026-10-30T00:00:00.000Z'), 'ISO 字符串应解析')
  const now = new Date()
  assert.equal(byKey.mcp.resetAt, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1), 'MCP/月应按次月 1 日 00:00 UTC 补算')
})

test('URL 自动匹配的区域模板按端点而非自定义路由名选择区域', async (t) => {
  const requests = fixture(t, { data: { available_balance: 5 } })
  const host = harness({}, ['custom-moonshot'], { MODEL_USAGE_TEST_MOONSHOT: 'test-cn' })
  const p = (await host.snapshot()).providers[0]
  assert.equal(p.adapter, 'moonshot-balance')
  assert.equal(p.balance.currency, 'CNY')
  assert.equal(requests[0].url, 'https://api.moonshot.cn/v1/users/me/balance')
})

test('显式 sub2api 模板仍自动获得 provider 的端点和凭据', async (t) => {
  const requests = fixture(t, { mode: 'unrestricted', isValid: true, balance: 5 })
  const host = harness({ adapters: { relay: 'sub2api' } }, ['relay'], { MODEL_USAGE_TEST_RELAY: 'test-relay' })
  assert.equal((await host.snapshot()).providers[0].status, 'ok')
  assert.equal(requests[0].url, 'https://relay.example/v1/usage')
  assert.equal(requests[0].authorization, 'Bearer test-relay')
})

test('窗口统一按 5h > 日 > 周 > 月排序（与上游返回顺序无关）', async (t) => {
  const requests = fixture(t, {
    mode: 'quota_limited', isValid: true,
    quota: { limit: 100, used: 40, remaining: 60, unit: 'USD' },
    rate_limits: [
      { window: '7d', limit: 70, used: 7 },
      { window: '5h', limit: 10, used: 1 },
      { window: '1d', limit: 20, used: 2 },
    ],
  })
  const host = harness({ adapters: { relay: 'sub2api' } }, ['relay'], { MODEL_USAGE_TEST_RELAY: 'test-relay' })
  const p = (await host.snapshot()).providers[0]
  assert.equal(p.status, 'ok')
  assert.deepEqual(p.windows.map((w) => w.key), ['rolling', 'daily', 'weekly'])
})

test('未知显式模板不偷偷退回自动探测', async (t) => {
  const requests = fixture(t)
  const host = harness({ adapters: { kimi1: 'missing-template' } }, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-key' })
  assert.deepEqual((await host.snapshot()).providers, [])
  assert.deepEqual(requests, [])
})

test('无 profile 环境变量时按当前 llm 路由自动识别 profile（kimi 不得落到 moonshot）', async (t) => {
  // 复现真实桌面宿主：DSH_PROFILE_DIR/DSH_PROFILE 只注入工具子进程，插件 Host 没有
  const saved = {}
  for (const k of ['DSH_PROFILE_DIR', 'DSH_PROFILE', 'DSH_HOME']) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.DSH_HOME = fileURLToPath(new URL('./fixtures/home', import.meta.url))
  invalidateProfileCache()
  t.after(() => {
    for (const k of ['DSH_PROFILE_DIR', 'DSH_PROFILE', 'DSH_HOME']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    invalidateProfileCache()
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, authorization: init.headers.authorization })
    return { ok: true, status: 200, async json() { return kimiReply } }
  })
  const host = harness({}, ['kimi1', 'kimi2'], {
    MODEL_USAGE_TEST_KIMI1: 'test-account-one',
    MODEL_USAGE_TEST_KIMI2: 'test-account-two',
  })
  const snap = await host.snapshot()
  assert.deepEqual(snap.providers.map((p) => [p.route, p.adapter, p.status]), [
    ['kimi1', 'kimi-coding', 'ok'], ['kimi2', 'kimi-coding', 'ok'],
  ])
  // 识别到 desktop profile：各自用独立凭据请求 kimi 官方域名（而非 moonshot）
  assert.deepEqual(requests, [
    { url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer test-account-one' },
    { url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer test-account-two' },
  ])
})

test('快照并行取数：本轮新数据统一以响应完成时刻为 fetchedAt，慢接口不再拖出「刚刷新就 10s」', async (t) => {
  const prevDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = fileURLToPath(new URL('./fixtures/profile', import.meta.url))
  invalidateProfileCache()
  t.after(() => {
    if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prevDir
    invalidateProfileCache()
  })
  let inflight = 0
  let maxInflight = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // 两个 kimi 账号都是慢接口：串行时 maxInflight 恒为 1，并行时为 2
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    if (init.headers.authorization === 'Bearer test-account-one') await new Promise((r) => setTimeout(r, 500))
    else await new Promise((r) => setTimeout(r, 100))
    inflight--
    return { ok: true, status: 200, async json() { return kimiReply } }
  })
  const host = harness({}, ['kimi1', 'kimi2'], {
    MODEL_USAGE_TEST_KIMI1: 'test-account-one',
    MODEL_USAGE_TEST_KIMI2: 'test-account-two',
  })
  const snap = await host.snapshot()
  assert.equal(snap.providers.length, 2)
  assert.equal(maxInflight, 2, '两个供应商应并行取数（串行时 maxInflight 为 1）')
  for (const p of snap.providers) {
    assert.equal(p.fetchedAt, snap.generatedAt, '本轮新数据的 fetchedAt 应统一为快照完成时刻')
  }
  // TTL 内的第二次快照：缓存数据保留原 fetchedAt（不得被刷新成最新）
  // 第二次快照与第一次完成落在同一毫秒，之后时钟再前进一步，仍不能改写缓存时间。
  let ticks = 0
  t.mock.method(Date, 'now', () => snap.generatedAt + (ticks++ > 0 ? 1 : 0))
  const snap2 = await host.snapshot()
  assert.equal(snap2.providers[0].fetchedAt, snap.providers[0].fetchedAt)
})

test('可选服务未注入时不影响额度初始化，profile 仍可从 pluginManager 读取', async (t) => {
  const requests = fixture(t)
  const host = harness({}, ['kimi1'], { MODEL_USAGE_TEST_KIMI1: 'test-account-one' }, {
    pluginManager: { profile: { dir: fileURLToPath(new URL('./fixtures/profile', import.meta.url)) } },
  })
  const snapshot = await host.snapshot()
  assert.deepEqual(snapshot.providers.map((p) => p.route), ['kimi1'])
  assert.equal(snapshot.providers[0].adapter, 'kimi-coding')
  assert.equal(requests.length, 1)
})
