import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 所有会话与凭据均为显式虚构值；加载 marketing.mjs 前隔离设备标识读取。
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

const NOW = 1_800_000_000_000
const PLAN_ID = 'zcode-start-immediate-test'
const CAMPAIGN_ID = 'campaign-immediate-test'
const MODEL_ID = 'glm-5.3-flash'

function runtimeHarness() {
  const effects = []
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
    events: { dispatch() { return [] } },
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
  }
  return { runtime: new LlmRuntime(ctx), effects }
}

function registerGlm(runtime) {
  return runtime.registerAdapter(['zai-coding-cn'], {
    providerInfo(provider) { return { id: provider, name: 'GLM Coding Plan' } },
    providerRetryPolicy() { return undefined },
    async listModels() { return [] },
    async *stream() {},
  })
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function emptyGiftResponse() {
  return { code: 0, data: { server_time: NOW / 1000, plans: [], balances: [] } }
}

function marketingResponse(effectiveAt, capabilities = ['model:' + MODEL_ID]) {
  return {
    code: 0,
    data: {
      server_time: NOW / 1000,
      deliveries: [{
        campaign_id: CAMPAIGN_ID,
        resource_position: 'banner',
        priority: 50,
        banner: {
          buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: PLAN_ID } } }],
          background: {
            args: {
              zcode_plan: {
                plan_id: PLAN_ID,
                name: 'Immediate Start Plan',
                ends_at: (NOW + 86400000) / 1000,
                entitlements: [{
                  entitlement_id: 'ent-immediate',
                  show_name: 'Pretty display name, not a wire id',
                  capabilities,
                  grant_units: 1000,
                  unit_type: 'token',
                  period: 'one_time',
                  effective_at: effectiveAt == null ? 0 : effectiveAt / 1000,
                }],
              },
            },
          },
        },
      }],
    },
  }
}

function claimResponse() {
  return {
    code: 0,
    data: {
      server_time: NOW / 1000,
      plan: {
        plan_id: PLAN_ID,
        name: 'Immediate Start Plan',
        ends_at: (NOW + 86400000) / 1000,
        // 精确 model id 与生效时间只由投放元数据补齐，证明 claim 后会合并两侧信息。
        entitlements: [{
          entitlement_id: 'ent-immediate',
          show_name: 'Pretty display name, not a wire id',
          grant_units: 1000,
          unit_type: 'token',
          period: 'one_time',
        }],
      },
    },
  }
}

async function hostHarness(t, runtime, effectiveAt, capabilities) {
  let handler
  let gateBalances = false
  let balanceCalls = 0
  let releaseBalance = null
  let notifyBalanceStarted
  const balanceStarted = new Promise((resolve) => { notifyBalanceStarted = resolve })

  t.mock.method(Date, 'now', () => NOW)
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = fileURLToPath(new URL('./fixtures/profile-empty', import.meta.url))
  invalidateProfileCache()
  t.after(async () => {
    gateBalances = false
    if (releaseBalance) {
      releaseBalance()
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
    invalidateProfileCache()
  })

  const resetFetch = async (url) => {
    const href = String(url)
    if (href.includes('/api/v1/coding-plan/reset/status')) {
      return jsonResponse({ code: 0, data: { available_five_hour_resets: [], available_week_resets: [] } })
    }
    if (href.includes('/api/v1/marketing/touch/action')) return jsonResponse({ code: 0, data: {} })
    if (href.includes('/api/v1/marketing/touch')) return jsonResponse(marketingResponse(effectiveAt, capabilities))
    if (href.includes('/api/v1/zcode-plan/billing/claim')) return jsonResponse(claimResponse())
    if (href.includes('/api/v1/zcode-plan/billing/balance')) {
      balanceCalls++
      if (gateBalances) {
        notifyBalanceStarted()
        await new Promise((resolve) => { releaseBalance = resolve })
      }
      return jsonResponse(emptyGiftResponse())
    }
    throw new Error('unexpected test URL: ' + href)
  }
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url)
    if (href === 'https://open.bigmodel.cn/api/monitor/usage/quota/limit') {
      return jsonResponse({ code: 0, data: { level: 'test', limits: [] } })
    }
    throw new Error('unexpected real fetch in test: ' + href)
  })

  const ctx = {
    effect(fn, label) {
      if (label !== 'model-usage: ledger' && label !== 'model-usage: pricing check') fn()
    },
    on() { return () => {} },
    get() { return null },
    inject(deps, fn) { fn(this) },
    logger: { warn() {} },
    llm: runtime,
    credentials: { async resolve() { return { value: 'test-glm-key' } } },
    connection: { admit: () => ({}) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  apply(ctx, {
    glm: { giftProvider: 'zai-coding-cn' },
    sessionResolver: async () => ({ source: 'test', zcodeJwt: 'test-zcode-jwt', businessJwt: 'test-business-jwt' }),
    resetFetch,
  })

  return {
    async rpc(endpoint, payload) {
      const req = new EventEmitter()
      req.method = 'POST'
      const response = new Promise((resolve) => {
        handler(req, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
      })
      req.emit('data', Buffer.from(JSON.stringify({ endpoint, payload })))
      req.emit('end')
      return response
    },
    holdBalance() { gateBalances = true },
    balanceStarted,
    get balanceCalls() { return balanceCalls },
  }
}

integrationTest('claimOffer 成功时不等待挂起的 balance，即时生效模型立即可见于真实 LlmRuntime', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, NOW - 1000)

  const snapshot = await host.rpc('snapshot')
  assert.equal(snapshot.ok, true)
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'))
  host.holdBalance()

  const claimed = await host.rpc('claimOffer', { planId: PLAN_ID, campaignId: CAMPAIGN_ID })
  await host.balanceStarted
  assert.equal(claimed.ok, true)
  assert.equal(claimed.value.status, 'success')
  assert.equal(claimed.value.plan.serverTime, NOW)
  assert.equal(host.balanceCalls, 2, '后台对账已发起并被 gate 挂起')
  assert.ok(llm.runtime.listProviders().some((p) => p.id === 'glm-gift'), 'claim 成功即注册，不等待 balance')
  assert.deepEqual((await llm.runtime.listModels('glm-gift')).map((m) => m.id), [MODEL_ID])
})

integrationTest('未来 effective_at 的领取结果不 synthetic 注册，仍等待 balance 白名单', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, NOW + 3600000)

  const snapshot = await host.rpc('snapshot')
  assert.equal(snapshot.ok, true)
  host.holdBalance()
  const claimed = await host.rpc('claimOffer', { planId: PLAN_ID, campaignId: CAMPAIGN_ID })
  await host.balanceStarted

  assert.equal(claimed.ok, true)
  assert.equal(claimed.value.status, 'success')
  assert.equal(host.balanceCalls, 2, '未来权益同样只做后台 balance 对账')
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'), 'pending 权益不得提前进入可执行模型目录')
})

integrationTest('缺少 capabilities 精确 model id 时不拿 show_name 冒充线协议 id', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  registerGlm(llm.runtime)
  const host = await hostHarness(t, llm.runtime, NOW - 1000, [])

  const snapshot = await host.rpc('snapshot')
  assert.equal(snapshot.ok, true)
  host.holdBalance()
  const claimed = await host.rpc('claimOffer', { planId: PLAN_ID, campaignId: CAMPAIGN_ID })
  await host.balanceStarted

  assert.equal(claimed.ok, true)
  assert.equal(claimed.value.status, 'success')
  assert.ok(!llm.runtime.listProviders().some((p) => p.id === 'glm-gift'), '展示名不是可执行模型白名单依据')
})
