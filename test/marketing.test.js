import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// telemetry 文件路径可注入（与 auth.mjs 同款测试接缝）
const dir = mkdtempSync(path.join(tmpdir(), 'dmu-marketing-'))
after(() => rmSync(dir, { recursive: true, force: true }))
process.env.DMU_ZCODE_TELEMETRY_FILE = path.join(dir, 'telemetry-state.json')
writeFileSync(process.env.DMU_ZCODE_TELEMETRY_FILE, JSON.stringify({ deviceMid: '11111111-2222-3333-4444-555555555555' }), 'utf8')

const {
  fetchClaimOffers, claimPlan, reportTouchAction,
  fetchGiftBalances, giftModelsFromBalances, readDeviceMid,
} = await import('../lib/zcode/marketing.mjs')

const SESSION = { zcodeJwt: 'z-jwt', businessJwt: 'b-jwt', businessFamily: 'bigmodel' }

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

test('readDeviceMid：读取注入文件并缓存', async () => {
  const mid = await readDeviceMid()
  assert.equal(mid, '11111111-2222-3333-4444-555555555555')
})

test('fetchClaimOffers：解析 Marketing Touch 投放并归一化领取套餐', async () => {
  const delivery = {
    campaign_id: '2101141259813175296',
    resource_position: 'banner',
    priority: 50,
    banner: {
      buttons: [
        { text: { format: '', content: '' }, action: { type: 'close' } },
        { text: { format: '', content: '' }, action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-nt-1026' } } },
      ],
      background: {
        type: 'bundle',
        bundle: { bundle: { src: 'https://cdn.example.com/x.zip', sha256: 'a'.repeat(64) }, entry: 'index.html' },
        args: {
          zcode_plan: {
            plan_id: 'zcode-v3-start-plan-nt-1026',
            name: 'ZCODE GLOBAL BUILD',
            priority: 111,
            starts_at: 1793012400,
            ends_at: 1793062800,
            entitlements: [{
              entitlement_id: 'ent-1',
              show_name: 'GLM-5.3-Flash',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3-flash'],
              grant_units: 300000000,
              period: 'one_time',
              effective_at: 1793026800,
              priority: 101,
            }],
          },
        },
      },
    },
  }
  let called = 0
  const fetchImpl = async (url) => {
    called++
    assert.ok(String(url).includes('/api/v1/marketing/touch'), '应请求 marketing/touch')
    return jsonRes({ code: 0, msg: '', data: { server_time: 1793058875, language: 'zh-CN', deliveries: [delivery] } })
  }
  const offers = await fetchClaimOffers(SESSION, fetchImpl)
  assert.equal(called, 1)
  assert.equal(offers.length, 1)
  const o = offers[0]
  assert.equal(o.planId, 'zcode-v3-start-plan-nt-1026')
  assert.equal(o.campaignId, '2101141259813175296')
  assert.equal(o.name, 'ZCODE GLOBAL BUILD')
  assert.equal(o.endsAt, 1793062800 * 1000)
  assert.equal(o.entitlements[0].model, 'GLM-5.3-Flash')
  assert.equal(o.entitlements[0].units, 300000000)
  assert.equal(o.entitlements[0].period, 'one_time')
  assert.deepEqual(o.entitlements[0].capabilities, ['model:glm-5.3-flash'])
  assert.equal(o.entitlements[0].effectiveAt, 1793026800 * 1000)
})

test('giftModelsFromBalances：耗尽/过期桶被排除，同名桶合并', () => {
  const now = Date.now()
  const models = giftModelsFromBalances([
    { planId: 'p1', model: 'glm-5.3-flash', remaining: 100, total: 300, expiresAt: now + 86400000, unitType: 'token' },
    { planId: 'p1', model: 'glm-5.3-flash', remaining: 50, total: 300, expiresAt: now + 172800000, unitType: 'token' },
    { planId: 'p1', model: 'glm-5.3-flash', remaining: 0, total: 300, expiresAt: now + 86400000, unitType: 'token' }, // 耗尽
    { planId: 'p1', model: 'glm-5.2', remaining: 10, total: 10, expiresAt: now - 1, unitType: 'token' }, // 过期
    { planId: 'p1', model: 'glm-5.1', remaining: null, total: null, expiresAt: null, unitType: 'token' }, // 未知余量：保留
  ])
  assert.equal(models.length, 2)
  const flash = models.find((m) => m.id === 'glm-5.3-flash')
  assert.equal(flash.remaining, 150) // 100 + 50，耗尽桶不计
})

test('fetchGiftBalances：仅归属 active 套餐的桶；ends_at 已过的 active 套餐判为过期', async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const fetchImpl = async () => jsonRes({
    code: 0, msg: '',
    data: {
      server_time: nowSec,
      plans: [
        { plan_id: 'p-active', name: 'Start', status: 'active', ends_at: nowSec + 3600 },
        { plan_id: 'p-stale', name: 'Old', status: 'active', ends_at: nowSec - 10 }, // active 但已过期
      ],
      balances: [
        { plan_id: 'p-active', bucket_id: 'b1', capabilities: ['model:glm-5.3-flash'], total_units: 300000000, used_units: 5, remaining_units: 299999995, unit_type: 'token', expires_at: nowSec + 3500 },
        { plan_id: 'p-stale', bucket_id: 'b2', capabilities: ['model:glm-5.2'], total_units: 10, used_units: 0, remaining_units: 10, unit_type: 'token', expires_at: nowSec - 5 },
        { plan_id: 'p-ghost', bucket_id: 'b3', capabilities: ['model:glm-5.1'], total_units: 1, remaining_units: 1, unit_type: 'token' }, // 无 active 归属：丢弃
      ],
    },
  })
  const bal = await fetchGiftBalances(SESSION, fetchImpl)
  assert.equal(bal.plans.length, 2)
  assert.equal(bal.plans[1].status, 'expired')
  assert.equal(bal.buckets.length, 1) // stale 套餐的桶被过期判定剔除、ghost 桶被归属过滤
  assert.equal(bal.buckets[0].model, 'glm-5.3-flash')
  assert.equal(bal.buckets[0].remaining, 299999995)
})

test('claimPlan：成功返回 plan；失败优先展示服务端 data.message', async () => {
  const ok = await claimPlan(SESSION, 'p1', async () => jsonRes({ code: 0, msg: '', data: { plan: { plan_id: 'p1', name: 'Start' } } }))
  assert.deepEqual(ok, { planId: 'p1', name: 'Start', raw: { plan_id: 'p1', name: 'Start' } })
  assert.equal('serverTime' in ok, false, '缺少 server_time 时保持原返回结构')
  const timed = await claimPlan(SESSION, 'p1', async () => jsonRes({ code: 0, msg: '', data: { server_time: 1793000000, plan: { plan_id: 'p1', name: 'Start' } } }))
  assert.equal(timed.serverTime, 1793000000000)
  await assert.rejects(
    () => claimPlan(SESSION, 'p1', async () => jsonRes({ code: 1005, msg: 'ignore-me', data: { message: '本期限领' } })),
    /本期限领/,
  )
})

test('reportTouchAction：best-effort，失败不抛出', async () => {
  assert.equal(await reportTouchAction(SESSION, 'c1', 'confirm', async () => jsonRes({ code: 0 })), true)
  assert.equal(await reportTouchAction(SESSION, 'c1', 'cancel', async () => { throw new Error('net down') }), false)
})

test('营销请求禁止重定向、隐藏底层凭据异常并拒绝 HTTP 失败 envelope', async () => {
  await assert.rejects(fetchGiftBalances(SESSION, async (_url, init) => {
    assert.equal(init.redirect, 'error')
    throw new Error(SESSION.zcodeJwt)
  }), (error) => !error.message.includes(SESSION.zcodeJwt) && /读取失败/.test(error.message))
  await assert.rejects(fetchGiftBalances(SESSION, async () => jsonRes({ code: 0, data: { plans: [] } }, 500)), /HTTP 500/)
  await assert.rejects(claimPlan(SESSION, 'p1', async () => jsonRes({ code: 1005, data: { message: SESSION.zcodeJwt + ' ' + SESSION.businessJwt } })), (error) => {
    assert.equal(error.message.includes(SESSION.zcodeJwt), false)
    assert.equal(error.message.includes(SESSION.businessJwt), false)
    return true
  })
  assert.equal(await reportTouchAction(SESSION, 'c1', 'confirm', async () => jsonRes({ code: 1005 })), false)
})

test('响应头到达后超时仍取消挂起的余额响应体', { timeout: 2000 }, async () => {
  const realSetTimeout = globalThis.setTimeout
  let fireTimeout
  globalThis.setTimeout = (callback) => { fireTimeout = callback; return realSetTimeout(() => {}, 1000) }
  let cancellations = 0
  const body = new ReadableStream({ cancel() { cancellations++ } })
  try {
    await assert.rejects(fetchGiftBalances(SESSION, async () => {
      realSetTimeout(() => fireTimeout(), 0)
      return new Response(body)
    }), /超时/)
    assert.equal(cancellations, 1)
    assert.equal(body.locked, false)
  } finally { globalThis.setTimeout = realSetTimeout }
})

test('余额响应大小受限，失败时取消流', async () => {
  let cancellations = 0
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
    cancel() { cancellations++ },
  })
  await assert.rejects(fetchGiftBalances(SESSION, async () => new Response(body)), /读取失败/)
  assert.equal(cancellations, 1)
  assert.equal(body.locked, false)
})

test('畸形套餐、未知余量和展示名称不会误注册或误判耗尽', async () => {
  const balances = await fetchGiftBalances(SESSION, async () => jsonRes({ code: 0, data: {
    plans: [null, {}, { plan_id: 'p1', status: 'active' }],
    balances: [
      { plan_id: 'p1', capabilities: ['model:glm-5.2'], remaining_units: null, total_units: '', used_units: false },
      { plan_id: 'p1', show_name: 'Not a model id', remaining_units: 10 },
      { plan_id: 'p1', capabilities: ['model:glm-5.3-flash'], remaining_units: 10, unit_type: 'request' },
      { plan_id: '', capabilities: ['model:ghost'], remaining_units: 10 },
    ],
  } }))
  assert.equal(balances.plans.length, 1)
  assert.equal(balances.buckets.length, 3)
  assert.equal(balances.buckets[0].remaining, null)
  assert.equal(balances.buckets[0].total, null)
  assert.equal(balances.buckets[0].used, null)
  assert.deepEqual(giftModelsFromBalances([null, ...balances.buckets]).map((m) => m.id), ['glm-5.2'])
})

test('余额桶截止时间不能晚于套餐截止时间', async () => {
  const endSec = Math.floor(Date.now() / 1000) + 3600
  const balance = await fetchGiftBalances(SESSION, async () => jsonRes({ code: 0, data: {
    plans: [{ plan_id: 'p1', status: 'active', ends_at: endSec }],
    balances: [
      { plan_id: 'p1', capabilities: ['model:glm-5.2'], remaining_units: 1 },
      { plan_id: 'p1', capabilities: ['model:glm-5.2'], remaining_units: 1, expires_at: endSec + 3600 },
      { plan_id: 'p1', capabilities: ['model:glm-5.2'], remaining_units: 1, expires_at: endSec - 1800 },
    ],
  } }))
  assert.deepEqual(balance.buckets.map((b) => b.expiresAt), [endSec * 1000, endSec * 1000, (endSec - 1800) * 1000])
})
