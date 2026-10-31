import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply } = await import('../lib/index.mjs')

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
    events: { dispatch: () => [] },
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
  }
  return { runtime: new LlmRuntime(ctx), effects }
}

const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const NOW = 1_800_000_000_000
const PLAN = {
  plan_id: 'test-plan', name: 'Test Start Plan', status: 'active',
  starts_at: Math.floor(NOW / 1000) - 10,
  ends_at: Math.floor(NOW / 1000) + 86400,
  entitlements: [],
}
const emptyBalance = { code: 0, data: { server_time: Math.floor(NOW / 1000), plans: [], balances: [] } }
const modelBalance = {
  code: 0,
  data: {
    server_time: Math.floor(NOW / 1000),
    plans: [PLAN],
    balances: [{
      plan_id: 'test-plan', bucket_id: 'bucket-1', capabilities: ['model:glm-5.3-flash'],
      unit_type: 'token', total_units: 300000000, used_units: 0,
      remaining_units: 300000000, expires_at: PLAN.ends_at,
    }],
  },
}

function hostHarness(t, balanceResponder) {
  let handler
  let balanceCalls = 0
  const ctx = {
    effect(fn, label) {
      if (label !== 'model-usage: ledger' && label !== 'model-usage: pricing check') fn()
    },
    on() { return () => {} },
    get() { return null },
    inject(deps, fn) { fn(this) },
    logger: { warn: () => {} },
    llm: t.runtime,
    credentials: { async resolve() { return null } },
    connection: { admit: () => ({}) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  apply(ctx, {
    sessionResolver: async () => ({ source: 'test', zcodeJwt: 'test-zcode-jwt', businessJwt: 'test-business-jwt' }),
    resetFetch: async (url) => {
      const href = String(url)
      if (href.includes('/api/v1/zcode-plan/billing/claim')) {
        return jsonResponse({ code: 0, data: { server_time: Math.floor(NOW / 1000), plan: PLAN } })
      }
      if (href.includes('/api/v1/zcode-plan/billing/balance')) {
        balanceCalls += 1
        return balanceResponder(balanceCalls)
      }
      throw new Error('unexpected test URL: ' + href)
    },
  })
  return {
    get balanceCalls() { return balanceCalls },
    async claim() {
      const req = new EventEmitter()
      req.method = 'POST'
      const response = new Promise((resolve) => {
        handler(req, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
      })
      req.emit('data', Buffer.from(JSON.stringify({ endpoint: 'claimOffer', payload: { planId: 'test-plan' } })))
      req.emit('end')
      const result = await response
      assert.equal(result.ok, true)
      assert.equal(result.value.status, 'success')
    },
  }
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 80; i++) {
    try { if (await predicate()) return } catch { /* 路由尚未注册属于未就绪，继续等待 */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('等待条件超时: ' + label)
}

integrationTest('领取后 balance 暂未入账时，有界重试会带入赠送模型', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  t.runtime = llm.runtime
  const host = hostHarness(t, (call) => jsonResponse(call === 1 ? emptyBalance : modelBalance))
  await host.claim()
  await waitFor(async () => (await llm.runtime.listModels('glm-gift')).length === 1, '赠送模型进入目录')
  assert.equal((await llm.runtime.listModels('glm-gift'))[0].id, 'glm-5.3-flash')
  assert.ok(host.balanceCalls >= 2, '首次空 balance 后应进行第二次有界刷新')
})

integrationTest('已有旧赠额时，重试必须等待本次 plan 的模型而非任意旧模型', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  t.runtime = llm.runtime
  const oldPlan = { ...PLAN, plan_id: 'old-plan', name: 'Old Start Plan' }
  const oldOnly = {
    code: 0,
    data: {
      server_time: Math.floor(NOW / 1000), plans: [oldPlan],
      balances: [{
        plan_id: 'old-plan', bucket_id: 'old-bucket', capabilities: ['model:glm-old'],
        unit_type: 'token', total_units: 100, used_units: 0, remaining_units: 100,
        expires_at: oldPlan.ends_at,
      }],
    },
  }
  const host = hostHarness(t, (call) => jsonResponse(call === 1 ? oldOnly : modelBalance))
  await host.claim()
  await waitFor(async () => (await llm.runtime.listModels('glm-gift')).some((m) => m.id === 'glm-5.3-flash'), '本次 plan 模型出现')
  assert.ok(host.balanceCalls >= 2, '旧模型存在不得让重试提前停止')
  assert.equal((await llm.runtime.listModels('glm-gift')).some((m) => m.id === 'glm-5.3-flash'), true)
})

integrationTest('迟到的旧空 balance 不得覆盖 claim 后的新模型目录', async (t) => {
  const llm = runtimeHarness()
  t.after(() => { for (const dispose of [...llm.effects].reverse()) dispose() })
  t.runtime = llm.runtime
  let releaseFirst
  const host = hostHarness(t, (call) => {
    if (call === 1) return new Promise((resolve) => { releaseFirst = () => resolve(jsonResponse(emptyBalance)) })
    return jsonResponse(modelBalance)
  })
  await host.claim()
  await waitFor(() => host.balanceCalls === 1, '第一次 balance 在途')
  await host.claim()
  await waitFor(async () => (await llm.runtime.listModels('glm-gift')).length === 1, '第二次 balance 带来模型')
  releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await llm.runtime.listModels('glm-gift')).length, 1, '旧响应不得把新模型覆盖为空')
})
