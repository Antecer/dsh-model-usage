import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 在加载 marketing.mjs 前隔离设备标识读取；测试只使用显式虚构会话与凭据。
const previousTelemetryFile = process.env.DMU_ZCODE_TELEMETRY_FILE
process.env.DMU_ZCODE_TELEMETRY_FILE = fileURLToPath(new URL('./fixtures/__missing_zcode_telemetry__.json', import.meta.url))
const { apply } = await import('../lib/index.mjs')
const { invalidateProfileCache } = await import('../lib/profile.mjs')
if (previousTelemetryFile === undefined) delete process.env.DMU_ZCODE_TELEMETRY_FILE
else process.env.DMU_ZCODE_TELEMETRY_FILE = previousTelemetryFile

const require = createRequire(import.meta.url)
let llmEntry = process.env.DSH_LLM_ENTRY || null
if (!llmEntry) {
  try {
    llmEntry = require.resolve('@deepseek-ai/dsh-llm')
  } catch (error) {
    if (process.resourcesPath) {
      llmEntry = require.resolve('@deepseek-ai/dsh-llm', {
        paths: [path.join(process.resourcesPath, 'app.asar', 'dsh')],
      })
    }
  }
}
const { LlmRuntime } = llmEntry ? await import(pathToFileURL(llmEntry).href) : {}
const integrationTest = llmEntry ? test : (name, fn) => test(name, { skip: '未找到真实 dsh-llm；可设置 DSH_LLM_ENTRY 指向当前实现' }, fn)

function runtimeHarness() {
  const effects = []
  let updates = 0
  const ctx = {
    effect(setup) {
      const iterator = setup()
      const step = iterator.next()
      assert.equal(step.done, false)
      assert.equal(typeof step.value, 'function')
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        step.value()
      }
      effects.push(dispose)
      return dispose
    },
    events: {
      dispatch(channel, args) {
        if (channel === 'emit' && args[0] === 'llm/adapters-updated') updates++
        return []
      },
    },
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
  }
  return {
    runtime: new LlmRuntime(ctx),
    effects,
    get updates() { return updates },
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function giftResponse(models, now) {
  const expiresAt = Math.floor((now + 24 * 3600 * 1000) / 1000)
  return {
    code: 0,
    data: {
      plans: [{ plan_id: 'test-plan', name: 'Test Start Plan', status: 'active', ends_at: expiresAt }],
      balances: models.map((model, index) => ({
        plan_id: 'test-plan',
        bucket_id: 'test-bucket-' + index,
        capabilities: ['model:' + model],
        unit_type: 'token',
        total_units: 1000,
        used_units: 100,
        remaining_units: 900,
        expires_at: expiresAt,
      })),
    },
  }
}

async function hostHarness(t, runtime, initialModels, options = {}) {
  let now = 1_800_000_000_000
  let models = [...initialModels]
  let handler
  const warnings = []
  const zcodeRequests = []
  const identityRequests = []
  const keys = options.keys ? { ...options.keys } : null
  const cleanups = []
  const listeners = new Map()
  let session = { source: 'test', zcodeJwt: 'test-zcode-jwt', businessJwt: 'test-business-jwt', businessFamily: options.family || 'bigmodel' }
  t.mock.method(Date, 'now', () => now)

  const previousProfileDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = options.profileDir || fileURLToPath(new URL('./fixtures/profile-empty', import.meta.url))
  invalidateProfileCache()
  t.after(() => {
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
    invalidateProfileCache()
  })

  const resetFetch = async (url) => {
    const href = String(url)
    zcodeRequests.push(href)
    if (href.includes('/api/v1/coding-plan/reset/status')) {
      return jsonResponse({ code: 0, data: {
        available_five_hour_resets: [{ expire_at: Math.floor((now + 3600 * 1000) / 1000) }],
        available_week_resets: [],
      } })
    }
    if (href.includes('/api/v1/marketing/touch')) return jsonResponse({ code: 0, data: { deliveries: [] } })
    if (href.includes('/api/v1/zcode-plan/billing/balance')) return options.balanceFetch ? options.balanceFetch(session) : jsonResponse(giftResponse(models, now))
    throw new Error('unexpected test URL: ' + href)
  }
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url)
    if (href === 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' || href === 'https://api.z.ai/api/monitor/usage/quota/limit') {
      return jsonResponse({ code: 0, data: {
        level: 'test',
        limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 10, nextResetTime: Math.floor((now + 3600 * 1000) / 1000) }],
      } })
    }
    throw new Error('unexpected real fetch in test: ' + href)
  })

  const ctx = {
    effect(fn, label) {
      if (label === 'model-usage: ledger' || label === 'model-usage: pricing check') return
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    on(event, fn) {
      const handlers = listeners.get(event) || new Set()
      handlers.add(fn)
      listeners.set(event, handlers)
      return () => handlers.delete(fn)
    },
    events: { dispatch(_kind, [event]) { return [...(listeners.get(event) || []), ...(options.onDirectoryUpdate ? [options.onDirectoryUpdate] : [])] } },
    get() { return null },
    inject(deps, fn) { fn(this) },
    logger: { warn(message) { warnings.push(String(message)) } },
    llm: runtime,
    credentials: { async resolve(ref) { const value = keys ? keys[ref] : 'test-key.test-secret'; return value ? { value } : null } },
    connection: { admit: () => ({}) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
    ...options.services,
  }
  apply(ctx, {
    sessionResolver: async () => session,
    glm: { giftProvider: options.giftProvider },
    adapters: options.adapters || {},
    credentials: options.credentials || {},
    accountFetch: async (url, init) => {
      identityRequests.push({ url: String(url), method: init.method })
      if (options.accountFetch) return options.accountFetch(url, init)
      if (String(url).endsWith('/getCustomerInfo')) return jsonResponse({ code: 200, data: { organizations: [{ organizationId: 'test-org', projects: [{ projectId: 'test-project', projectType: 1 }] }] } })
      if (String(url).endsWith('/api_keys')) return jsonResponse({ code: 200, data: [{ apiKey: 'test-key', secretKey: '******', keyType: 1 }] })
      if (String(url).endsWith('/copy/test-key')) return jsonResponse({ code: 200, data: { apiKey: 'test-key', secretKey: 'test-secret' } })
      throw new Error('unexpected account request')
    },
    resetFetch,
  })

  const dispose = () => { for (const fn of cleanups.splice(0).reverse()) fn() }
  t.after(dispose)
  return {
    dispose,
    setSession(value) { session = value },
    warnings,
    zcodeRequests,
    identityRequests,
    setKey(ref, value) { keys[ref] = value; for (const listener of listeners.get('credentials/reference-updated') || []) listener(ref) },
    setModels(next) { models = [...next] },
    advancePastGiftTtl() { now += 61000 },
    advance(ms) { now += ms },
    async rpc(endpoint, payload) {
      const req = new EventEmitter()
      req.method = 'POST'
      const response = new Promise((resolve) => {
        handler(req, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
      })
      req.emit('data', Buffer.from(JSON.stringify({ endpoint, payload })))
      req.emit('end')
      const result = await response
      assert.equal(result.ok, true)
      return result.value
    },
    snapshot() { return this.rpc('snapshot') },
  }
}

function registerGlm(runtime) {
  return runtime.registerAdapter(['zai-coding-cn'], {
    providerInfo(provider) { return { id: provider, name: 'GLM Coding Plan' } },
    providerRetryPolicy() { return undefined },
    async listModels() { return [] },
    async *stream() {},
  })
}


function registerGlmRoute(runtime, route, name) {
  return runtime.registerAdapter([route], {
    providerInfo(provider) { return { id: provider, name } },
    providerRetryPolicy() { return undefined },
    async listModels() { return [] },
    async *stream() {},
  })
}
integrationTest('GLM 快照注册赠额模型，60s TTL 后新增模型会刷新真实 LlmRuntime 目录', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'])

  const first = await host.snapshot()
  assert.equal(first.providers[0].adapter, 'glm-coding')
  const giftProvider = llm.runtime.listProviders().find((p) => p.id === 'glm-gift')
  assert.ok(giftProvider, '应注册 glm-gift 路由')
  assert.equal(giftProvider.name, 'GLM Coding Plan · 赠送', '分组名前缀应同步自关联 GLM provider')
  const providerIds = llm.runtime.listProviders().map((p) => p.id)
  assert.equal(providerIds[providerIds.indexOf('glm-gift') - 1], 'zai-coding-cn', 'glm-gift 应紧跟关联 GLM provider')
  assert.deepEqual((await llm.runtime.listModels('glm-gift')).map((m) => m.id), ['glm-5.3-flash'])
  const updatesAfterFirst = llm.updates

  await host.snapshot()
  assert.equal(llm.updates, updatesAfterFirst, '签名不变时不得重复发布目录')

  host.setModels(['glm-5.3-flash', 'glm-4.7-flash'])
  host.advancePastGiftTtl()
  await host.snapshot()

  assert.equal(llm.updates, updatesAfterFirst + 1, '模型 id 签名变化必须触发一次 adapters-updated')
  assert.deepEqual(
    (await llm.runtime.listModels('glm-gift')).map((m) => m.id),
    ['glm-5.3-flash', 'glm-4.7-flash'],
    '余额新增模型后，即使适配器已注册也必须重新发布模型目录',
  )
})

integrationTest('赠额模型清空会注销并清理签名，后续出现新模型可重新注册', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'])
  await host.snapshot()
  assert.ok(llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))

  host.setModels([])
  host.advancePastGiftTtl()
  await host.snapshot()
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))

  host.setModels(['glm-4.7-flash'])
  host.advancePastGiftTtl()
  await host.snapshot()
  assert.deepEqual((await llm.runtime.listModels('glm-gift')).map((m) => m.id), ['glm-4.7-flash'])
})

integrationTest('首次注册失败会单次脱敏告警，冲突解除后的快照可恢复注册', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const disposeConflict = llm.runtime.registerAdapter(['glm-gift'], {
    providerInfo(provider) { return { id: provider, name: 'External gift owner' } },
    providerRetryPolicy() { return undefined },
    async listModels() { return [] },
    async *stream() {},
  })
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'])

  await host.snapshot()
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /GLM 赠送模型注册失败/)
  assert.ok(!host.warnings[0].includes('test-zcode-jwt'))
  assert.ok(!host.warnings[0].includes('test-business-jwt'))
  assert.ok(!host.warnings[0].includes('test-glm-key'))

  disposeConflict()
  host.advancePastGiftTtl()
  await host.snapshot()
  assert.deepEqual((await llm.runtime.listModels('glm-gift')).map((m) => m.id), ['glm-5.3-flash'])
})

integrationTest('replace 遇到已释放句柄时告警并立即重注册，新模型目录仍可恢复', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'])
  await host.snapshot()

  // 模拟宿主 fiber 已释放赠额注册，而插件尚未收到下一轮余额同步。
  llm.effects.at(-1)()
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  host.setModels(['glm-5.3-flash', 'glm-4.7-flash'])
  host.advancePastGiftTtl()
  await host.snapshot()

  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /GLM 赠送模型刷新失败/)
  assert.ok(!host.warnings[0].includes('test-zcode-jwt'))
  assert.ok(!host.warnings[0].includes('test-business-jwt'))
  assert.deepEqual(
    (await llm.runtime.listModels('glm-gift')).map((m) => m.id),
    ['glm-5.3-flash', 'glm-4.7-flash'],
  )
})

integrationTest('不同区域 provider：赠送以账户 Key 精确匹配对应区域路由', async (t) => {
  const cases = [
    { family: 'bigmodel', route: 'bigmodel-coding', name: 'GLM BigModel', other: 'zai-coding-cn' },
    { family: 'zai', route: 'zai-coding-cn', name: 'GLM Z.ai', other: 'bigmodel-coding' },
  ]
  for (const item of cases) {
    const llm = runtimeHarness()
    const disposers = [
      registerGlmRoute(llm.runtime, 'zai-coding-cn', 'GLM Z.ai'),
      registerGlmRoute(llm.runtime, 'bigmodel-coding', 'GLM BigModel'),
    ]
    try {
      const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
        family: item.family,
        profileDir: fileURLToPath(new URL('./fixtures/profile-gift-family', import.meta.url)),
      })
      const snap = await host.snapshot()
      const giftProvider = llm.runtime.listProviders().find((p) => p.id === 'glm-gift')
      assert.ok(giftProvider, '应注册 glm-gift 路由')
      assert.equal(giftProvider.name, item.name + ' · 赠送', '分组名前缀应同步自当前账户 Key 匹配的 GLM provider')
      const providerIds = llm.runtime.listProviders().map((p) => p.id)
      assert.equal(providerIds[providerIds.indexOf('glm-gift') - 1], item.route, 'glm-gift 应紧跟关联 GLM 账户所在 provider')
      const own = snap.providers.find((p) => p.route === item.route)
      const other = snap.providers.find((p) => p.route === item.other)
      assert.ok(own && own.gift, '赠送额度只应挂到关联 GLM 卡片')
      assert.equal(other && other.gift, undefined, '非关联 GLM 卡片不得显示赠送额度')
    } finally {
      for (const dispose of [...llm.effects].reverse()) dispose()
      for (const dispose of disposers) dispose()
    }
  }
})

// 两个同区域 API Key 不足以确认哪个属于本机 ZCode 登录。
integrationTest('同区域多账户不猜测首项；显式展示绑定保持名称与路由一致', async (t) => {
  for (const giftProvider of [undefined, 'glm-b']) {
    const llm = runtimeHarness()
    const first = registerGlmRoute(llm.runtime, 'glm-a', '智谱主账号')
    const second = registerGlmRoute(llm.runtime, 'glm-b', '智谱备用')
    const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], { giftProvider, adapters: { 'glm-a': 'glm-coding', 'glm-b': 'glm-coding' } })
    try {
      const snap = await host.snapshot()
      assert.equal(snap.giftProvider.parentRoute, giftProvider || null)
      assert.deepEqual(snap.providers.filter((p) => p.gift).map((p) => p.route), giftProvider ? ['glm-b'] : [])
      assert.equal(llm.runtime.listProviders().find((p) => p.id === 'glm-gift')?.name, giftProvider ? '智谱备用 · 赠送' : '智谱 · 赠送')
    } finally { host.dispose(); first(); second() }
  }
})

integrationTest('销毁作用域会注销赠送路由，迟到余额不会重新注册', async (t) => {
  const llm = runtimeHarness()
  const parent = registerGlm(llm.runtime)
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
    balanceFetch: () => new Promise((resolve) => { release = resolve; started() }),
  })
  const snapshot = host.snapshot()
  await entered
  host.dispose()
  release(jsonResponse(giftResponse(['glm-5.3-flash'], Date.now())))
  await snapshot
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  parent()
})

integrationTest('普通并发快照共用余额请求；排序通知执行真实订阅者', async (t) => {
  const llm = runtimeHarness()
  const parent = registerGlm(llm.runtime)
  const other = registerGlmRoute(llm.runtime, 'other-provider', '其它')
  let notified = 0
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], { onDirectoryUpdate: () => { notified++ } })
  await Promise.all([host.snapshot(), host.snapshot()])
  assert.equal(host.zcodeRequests.filter((url) => url.includes('/billing/balance')).length, 1)
  assert.ok(notified > 0, '不能只调用 dispatch 而丢弃返回的订阅者')
  assert.deepEqual(llm.runtime.listProviders().map((p) => p.id), ['zai-coding-cn', 'glm-gift', 'other-provider'])
  host.dispose()
  assert.deepEqual(llm.runtime.listProviders().map((p) => p.id), ['zai-coding-cn', 'other-provider'])
  parent(); other()
})

integrationTest('外部登录会话变更会清掉旧赠额，即使新账户余额查询失败', async (t) => {
  const llm = runtimeHarness()
  const parent = registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
    balanceFetch: (session) => session.zcodeJwt === 'test-zcode-jwt' ? jsonResponse(giftResponse(['glm-5.3-flash'], Date.now())) : Promise.reject(new Error('offline')),
  })
  await host.snapshot()
  assert.ok(llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  host.setSession({ zcodeJwt: 'different-test-session', businessJwt: 'different-test-business' })
  host.advancePastGiftTtl()
  await host.snapshot()
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  host.dispose(); parent()
})

integrationTest('到期计时回退关联同名模型，余额接口移除桶后仍保留截止证据', async (t) => {
  const llm = runtimeHarness()
  const parent = llm.runtime.registerAdapter(['zai-coding-cn'], {
    providerInfo: (id) => ({ id, name: '智谱' }), providerRetryPolicy() {},
    listModels: async (provider) => [{ provider, id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }],
    resolveModel: async (provider, id) => ({ provider, id, name: id }),
  })
  let selection = { provider: 'glm-gift', model: 'glm-5.3-flash' }
  let switches = 0
  const agent = { id: 'test-session', session: { header: { cwd: '.' } }, ctx: { on: () => () => {} } }
  let due
  const originalTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay > 60000) { due = callback; return { unref() {} } }
    return originalTimeout(callback, delay, ...args)
  })
  let empty = false
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
    balanceFetch: () => jsonResponse(giftResponse(empty ? [] : ['glm-5.3-flash'], Date.now())),
    services: {
      agents: { list: () => [agent], get: (id) => id === agent.id ? agent : undefined },
      sessionController: { agents: {
        selectionFor: () => ({ get current() { return selection } }),
        serializeImageAdmission: (_agent, fn) => fn(),
        selectForNextRequest: (_agent, next) => { selection = next; switches++ },
      } },
    },
  })
  await host.snapshot()
  assert.equal(typeof due, 'function')
  assert.equal(switches, 0)
  empty = true
  await host.rpc('snapshot', { refresh: true })
  assert.equal(switches, 0, '空余额不是到期证据')
  host.advance(24 * 3600 * 1000 + 1)
  due()
  for (let i = 0; i < 20 && !switches; i++) await new Promise(setImmediate)
  assert.deepEqual(selection, { provider: 'zai-coding-cn', model: 'GLM-5.3-Flash' })
  assert.equal(switches, 1)
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  host.dispose(); parent()
})

function accountInventory(secrets, requests = []) {
  return async (url, init) => {
    requests.push({ url: String(url), method: init.method })
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.Authorization, 'test-business-jwt')
    if (String(url).endsWith('/getCustomerInfo')) return jsonResponse({ code: 200, data: { organizations: [{ organizationId: 'test-org', projects: [{ projectId: 'test-project', projectType: 1 }] }] } })
    if (String(url).endsWith('/api_keys')) return jsonResponse({ code: 200, data: Object.keys(secrets).map((apiKey) => ({ apiKey, secretKey: '******', keyType: 1 })) })
    const id = decodeURIComponent(String(url).split('/copy/')[1] || '')
    if (Object.hasOwn(secrets, id)) return jsonResponse({ code: 200, data: { apiKey: id, secretKey: secrets[id] } })
    throw new Error('unexpected identity URL')
  }
}

integrationTest('多个同区域账户：完整 Key 命中才自动绑定，不按区域或排列顺序猜测', async (t) => {
  for (const item of [
    { secrets: { owned: 'valid' }, keyA: 'other.valid', keyB: 'owned.valid', parent: 'bigmodel-second', status: 'matched' },
    { secrets: { owned: 'valid' }, keyA: 'other.valid', keyB: 'owned.wrong', parent: null, status: 'unmatched' },
    { secrets: { owned: 'valid', other: 'valid' }, keyA: 'other.valid', keyB: 'owned.valid', parent: null, status: 'ambiguous' },
  ]) {
    const llm = runtimeHarness()
    const first = registerGlmRoute(llm.runtime, 'bigmodel-coding', '智谱主账号')
    const second = registerGlmRoute(llm.runtime, 'bigmodel-second', '智谱备用')
    const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
      profileDir: fileURLToPath(new URL('./fixtures/profile-gift-family', import.meta.url)),
      keys: { MODEL_USAGE_TEST_BIGMODEL: item.keyA, MODEL_USAGE_TEST_BIGMODEL_SECOND: item.keyB },
      accountFetch: accountInventory(item.secrets),
    })
    try {
      const snap = await host.snapshot()
      assert.equal(snap.giftProvider.parentRoute, item.parent)
      assert.equal(snap.giftProvider.bindingStatus, item.status)
      assert.deepEqual(snap.providers.filter((p) => p.gift).map((p) => p.route), item.parent ? [item.parent] : [])
      const gift = llm.runtime.listProviders().find((p) => p.id === 'glm-gift')
      assert.equal(gift.name, item.parent ? '智谱备用 · 赠送' : '智谱 · 赠送')
      if (item.parent) {
        const order = llm.runtime.listProviders().map((p) => p.id)
        assert.equal(order[order.indexOf('glm-gift') - 1], item.parent)
      }
      const serialized = JSON.stringify(snap)
      for (const secret of [item.keyA, item.keyB, 'test-business-jwt', 'test-org']) assert.ok(!serialized.includes(secret))
    } finally { host.dispose(); first(); second() }
  }
})

integrationTest('Key 更新与缺失权威凭据引用会使旧绑定失效，不借默认 Key 关联', async (t) => {
  const llm = runtimeHarness()
  const parent = registerGlmRoute(llm.runtime, 'bigmodel-coding', '智谱')
  const options = {
    profileDir: fileURLToPath(new URL('./fixtures/profile-gift-family', import.meta.url)),
    keys: { MODEL_USAGE_TEST_BIGMODEL: 'owned.valid', ZAI_CODING_CN_API_KEY: 'owned.valid' },
    accountFetch: accountInventory({ owned: 'valid' }),
  }
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], options)
  try {
    assert.equal((await host.snapshot()).giftProvider.parentRoute, 'bigmodel-coding')
    host.setKey('MODEL_USAGE_TEST_BIGMODEL', 'different.account')
    assert.equal((await host.snapshot()).giftProvider.parentRoute, null)
    host.setKey('MODEL_USAGE_TEST_BIGMODEL', undefined)
    assert.equal((await host.snapshot()).giftProvider.parentRoute, null)
  } finally { host.dispose(); parent() }
})

integrationTest('身份比对期间换 Key：迟到旧账户结果不得重新绑定', async (t) => {
  const llm = runtimeHarness()
  const parent = registerGlmRoute(llm.runtime, 'bigmodel-coding', '智谱')
  let announce, release
  const entered = new Promise((resolve) => { announce = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  const inventory = accountInventory({ owned: 'valid' })
  let hold = true
  const host = await hostHarness(t, llm.runtime, ['glm-5.3-flash'], {
    profileDir: fileURLToPath(new URL('./fixtures/profile-gift-family', import.meta.url)),
    keys: { MODEL_USAGE_TEST_BIGMODEL: 'owned.valid' },
    accountFetch: async (url, init) => {
      if (hold && String(url).includes('/copy/')) { announce(); return pending }
      return inventory(url, init)
    },
  })
  try {
    const stale = host.snapshot()
    await entered
    host.setKey('MODEL_USAGE_TEST_BIGMODEL', 'different.account')
    hold = false
    release(jsonResponse({ code: 200, data: { apiKey: 'owned', secretKey: 'valid' } }))
    assert.equal((await stale).giftProvider.parentRoute, null)
    assert.equal((await host.snapshot()).giftProvider.parentRoute, null)
  } finally { host.dispose(); parent() }
})
