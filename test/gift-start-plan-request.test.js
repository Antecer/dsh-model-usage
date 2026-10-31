import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { GiftModelAdapter, GIFT_PROVIDER } from '../lib/zcode/gift-adapter.mjs'
import {
  START_PLAN_ORIGIN,
  START_PLAN_ENDPOINT,
  START_PLAN_APP_VERSION,
  START_PLAN_CONTEXT_SOURCE,
  START_PLAN_SYSTEM_BLOCKS,
  composeStartPlanSystem,
} from '../lib/zcode/start-plan-context.mjs'

// 已验证的官方请求形状来自 2026-10-31 的捕获快照；测试只读夹具，不发真实网络请求。
const EVIDENCE = JSON.parse(await readFile(
  new URL('./fixtures/start-plan-system-context.json', import.meta.url), 'utf8'))
const TOKEN = 'synthetic-zcode-jwt'
const DEVICE = 'synthetic-device-mid'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_HEADERS = ['x-session-id', 'x-query-id', 'x-request-id', 'x-zcode-trace-id']

const event = (value) => 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n'
const packets = [
  event({ type: 'message_start', message: { id: 'msg-start-plan', role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  event({ type: 'content_block_stop', index: 0 }),
  event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
  event({ type: 'message_stop' }),
]

function sseResponse(chunks) {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk))
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < encoded.length) controller.enqueue(encoded[index++])
      else controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function makeAdapter(overrides = {}) {
  return new GiftModelAdapter({
    getModels: () => [],
    resolveAuth: async () => ({ token: TOKEN, deviceMid: DEVICE }),
    ...overrides,
  })
}

function header(headers, name) {
  const target = name.toLowerCase()
  if (headers instanceof Headers) return headers.get(target)
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

/** 用 mock fetch 收集请求并耗尽 SSE；不发真实网络请求。 */
async function runStreams(adapter, options = {}, times = 1) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return sseResponse(packets)
  }
  try {
    for (let index = 0; index < times; index++) {
      for await (const _chunk of adapter.stream({
        provider: GIFT_PROVIDER,
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        ...options,
      })) { /* 仅耗尽流，请求断言在外层完成 */ }
    }
    return calls
  } finally {
    globalThis.fetch = realFetch
  }
}

async function requestFor(adapter, options = {}) {
  const calls = await runStreams(adapter, options, 1)
  const requests = calls.filter((call) => String(call.url) === START_PLAN_ENDPOINT)
  assert.equal(requests.length, 1, '每次 stream 应只向 Start Plan 端点发送一次请求')
  return requests[0]
}

test('start-plan-context 常量与官方证据 JSON 一致', () => {
  assert.equal(START_PLAN_ORIGIN, 'https://zcode.z.ai')
  assert.equal(START_PLAN_ENDPOINT, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
  assert.equal(START_PLAN_APP_VERSION, '3.17.1')

  assert.equal(Array.isArray(START_PLAN_SYSTEM_BLOCKS), true)
  assert.equal(START_PLAN_SYSTEM_BLOCKS.length, 3)
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, EVIDENCE.system)
  assert.equal('cache_control' in START_PLAN_SYSTEM_BLOCKS[0], false, '块 1 不带 cache_control')
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS[1].cache_control, { type: 'ephemeral' })
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS[2].cache_control, { type: 'ephemeral' })

  assert.equal(typeof START_PLAN_CONTEXT_SOURCE, 'object')
  assert.notEqual(START_PLAN_CONTEXT_SOURCE, null)
  assert.equal(START_PLAN_CONTEXT_SOURCE.desktopVersion, '3.17.1')
  assert.equal(START_PLAN_CONTEXT_SOURCE.cliVersion, '0.17.1')
  assert.equal(START_PLAN_CONTEXT_SOURCE.desktopVersion, EVIDENCE.source.desktopVersion)
  assert.equal(START_PLAN_CONTEXT_SOURCE.cliVersion, EVIDENCE.source.cliVersion)
  assert.equal(START_PLAN_CONTEXT_SOURCE.upstream, EVIDENCE.source.upstream)
  assert.equal(START_PLAN_CONTEXT_SOURCE.upstreamLicense, EVIDENCE.source.upstreamLicense)
  assert.equal(typeof START_PLAN_CONTEXT_SOURCE.upstream, 'string')
  assert.equal(typeof START_PLAN_CONTEXT_SOURCE.upstreamLicense, 'string')
})

test('composeStartPlanSystem：缺省与空白返回三块副本且不修改常量', () => {
  const snapshot = structuredClone(START_PLAN_SYSTEM_BLOCKS)
  for (const caller of [undefined, null, '', '   ', '\n\t ']) {
    const result = composeStartPlanSystem(caller)
    assert.deepEqual(result, EVIDENCE.system, '调用方 system 为 ' + JSON.stringify(caller) + ' 时保持三块原文')
    assert.notEqual(result, START_PLAN_SYSTEM_BLOCKS, '必须返回副本，不能暴露常量数组本身')
    assert.notEqual(result[0], START_PLAN_SYSTEM_BLOCKS[0])
    assert.notEqual(result[2], START_PLAN_SYSTEM_BLOCKS[2])
  }
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, snapshot, '常量不得被调用修改')
})

test('composeStartPlanSystem：字符串追加到第三块末尾并保留 cache_control', () => {
  const result = composeStartPlanSystem('保持简洁')
  const base = START_PLAN_SYSTEM_BLOCKS[2]
  assert.equal(result.length, 3)
  assert.deepEqual(result.slice(0, 2), START_PLAN_SYSTEM_BLOCKS.slice(0, 2))
  assert.equal(result[2].type, 'text')
  assert.deepEqual(result[2].cache_control, { type: 'ephemeral' })
  assert.equal(result[2].text, base.text + '\n\n保持简洁')
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, EVIDENCE.system, '常量不得被调用修改')
})

test('composeStartPlanSystem：数组按序连接后追加，不修改常量', () => {
  const single = composeStartPlanSystem(['唯一指令'])
  assert.equal(single.length, 3)
  assert.equal(single[2].text, START_PLAN_SYSTEM_BLOCKS[2].text + '\n\n唯一指令')

  const result = composeStartPlanSystem(['第一条', { type: 'text', text: '第二条' }])
  const base = START_PLAN_SYSTEM_BLOCKS[2]
  assert.equal(result.length, 3)
  assert.deepEqual(result.slice(0, 2), START_PLAN_SYSTEM_BLOCKS.slice(0, 2))
  assert.deepEqual(result[2].cache_control, { type: 'ephemeral' })
  assert.equal(result[2].text.startsWith(base.text + '\n\n'), true, '数组内容也必须追加到第三块末尾')
  const appended = result[2].text.slice(base.text.length)
  assert.equal(appended.includes('第一条'), true)
  assert.equal(appended.includes('第二条'), true)
  assert.ok(appended.indexOf('第一条') < appended.indexOf('第二条'), '数组顺序必须保留')
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, EVIDENCE.system, '常量不得被调用修改')

  const empty = composeStartPlanSystem([])
  assert.deepEqual(empty, EVIDENCE.system)
})

test('模型元数据：按模型区分 contextWindow 与 defaultMaxTokens，且仅文本输入', async () => {
  const adapter = makeAdapter()
  for (const [model, contextWindow, defaultMaxTokens] of [
    ['glm-5.3-flash', 1000000, 128000],
    ['glm-5.2', 1000000, 128000],
    ['glm-5-turbo', 200000, 64000],
    ['custom-model', 128000, 16384],
  ]) {
    const resolved = await adapter.resolveModel(GIFT_PROVIDER, model)
    assert.equal(resolved.provider, GIFT_PROVIDER)
    assert.equal(resolved.id, model)
    assert.equal(resolved.context.contextWindow, contextWindow, model + ' contextWindow')
    assert.equal(resolved.defaultMaxTokens, defaultMaxTokens, model + ' defaultMaxTokens')
    assert.deepEqual([...resolved.inputModalities], ['text'], model + ' inputModalities')
  }

  const listing = new GiftModelAdapter({
    getModels: () => [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
      { id: 'glm-5-turbo', name: 'GLM 5 Turbo' },
    ],
    resolveAuth: async () => ({ token: TOKEN, deviceMid: DEVICE }),
  })
  const listed = await listing.listModels(GIFT_PROVIDER)
  assert.deepEqual(listed.map((m) => [m.id, [...m.inputModalities]]), [
    ['glm-5.3-flash', ['text']],
    ['glm-5-turbo', ['text']],
  ])
})

test('stream 请求：Start Plan 端点与完整已验证请求头', async () => {
  const request = await requestFor(makeAdapter())
  assert.equal(String(request.url), 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
  assert.equal(request.init.method, 'POST')

  const headers = request.init.headers
  const exactHeaders = {
    authorization: 'Bearer ' + TOKEN,
    'x-api-key': TOKEN,
    'x-title': 'DSH',
    'x-zcode-agent': 'dsh',
    'http-referer': 'https://zcode.z.ai',
    'x-zcode-app-version': '3.17.1',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-device-mid': DEVICE,
    'x-platform': process.platform + '-' + process.arch,
    'x-release-channel': 'production',
    'x-zcode-session-type': 'main',
    'x-zcode-query-source': 'main_turn',
  }
  for (const [name, expected] of Object.entries(exactHeaders)) assert.equal(header(headers, name), expected, name)
  assert.match(String(header(headers, 'user-agent')), /^dsh-model-usage\//)
  for (const name of ['x-client-language', 'x-client-timezone', 'x-os-version']) {
    const value = header(headers, name)
    assert.equal(typeof value, 'string', name + ' 必须是字符串')
    assert.ok(value.trim().length > 0, name + ' 不能为空')
  }
  const osCategory = header(headers, 'x-os-category')
  assert.ok(['windows', 'macos', 'linux'].includes(osCategory), 'x-os-category 必须是 windows/macos/linux')
  assert.equal(header(headers, 'x-zcode-query-source'), 'main_turn')

  const ids = ID_HEADERS.map((name) => {
    const value = header(headers, name)
    assert.match(String(value), UUID_RE, name + ' 必须是合法 UUID')
    return value
  })
  assert.equal(new Set(ids).size, 4, '同一次请求的 session/query/request/trace id 必须两两不同')
})

test('stream 请求体：三块 system、thinking、effort、metadata 与无采样参数', async () => {
  const request = await requestFor(makeAdapter())
  const headers = request.init.headers
  const body = JSON.parse(request.init.body)

  assert.equal(body.model, 'GLM-5.3-Flash')
  assert.equal(body.max_tokens, 128000)
  assert.equal(body.stream, true)
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.deepEqual(body.output_config, { effort: 'low' })
  assert.deepEqual(body.system, START_PLAN_SYSTEM_BLOCKS, '未传调用方 system 时使用三块原文')

  assert.equal(typeof body.metadata.user_id, 'string', 'metadata.user_id 必须是 JSON 字符串')
  assert.deepEqual(JSON.parse(body.metadata.user_id), {
    device_id: header(headers, 'x-device-mid'),
    account_uuid: '',
    session_id: header(headers, 'x-session-id'),
  })
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  assert.equal('temperature' in body, false)
  assert.equal('top_p' in body, false)
  assert.equal('stop_sequences' in body, false)
})

test('stream 请求体：调用方 system 追加到第三块末尾', async () => {
  const request = await requestFor(makeAdapter(), { system: '保持简洁' })
  const body = JSON.parse(request.init.body)
  const [first, second, third] = START_PLAN_SYSTEM_BLOCKS
  assert.equal(body.system.length, 3)
  assert.deepEqual(body.system.slice(0, 2), [first, second])
  assert.deepEqual(body.system[2], { ...third, text: third.text + '\n\n保持简洁' })
})

test('DSH system 消息：文本并入第三块，且不进入 body.messages', async () => {
  const systemMessage = { role: 'system', content: [{ type: 'text', text: 'HIST' }] }
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  const request = await requestFor(makeAdapter(), { messages: [systemMessage, userMessage] })
  const body = JSON.parse(request.init.body)
  const base = START_PLAN_SYSTEM_BLOCKS[2]
  assert.equal(body.system.length, 3)
  assert.deepEqual(body.system.slice(0, 2), START_PLAN_SYSTEM_BLOCKS.slice(0, 2))
  assert.deepEqual(body.system[2], { ...base, text: base.text + '\n\nHIST' })
  assert.deepEqual(body.system[2].cache_control, { type: 'ephemeral' }, '第三块 cache_control 必须保留')
  assert.deepEqual(body.messages, [userMessage], 'system 消息不得重复进入 Anthropic messages')
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, EVIDENCE.system, 'START_PLAN_SYSTEM_BLOCKS 不得被请求修改')
})

test('DSH system 消息：options.system 在前、会话 system 在后合并', async () => {
  const request = await requestFor(makeAdapter(), {
    system: 'OPT',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'HIST' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  })
  const body = JSON.parse(request.init.body)
  const base = START_PLAN_SYSTEM_BLOCKS[2]
  assert.equal(body.system.length, 3)
  assert.deepEqual(body.system[2], { ...base, text: base.text + '\n\nOPT\n\nHIST' })
})

test('DSH system 消息：多条按序空行分隔，空白/空内容忽略，string content 可用', async () => {
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'S1' }] },
    { role: 'system', content: [] },
    { role: 'system', content: [{ type: 'text', text: '   ' }] },
    { role: 'system', content: 'S2' },
    { role: 'system', content: [{ type: 'text', text: 'S3' }] },
    { role: 'system', content: '\n\t ' },
    userMessage,
  ]
  const request = await requestFor(makeAdapter(), { messages })
  const body = JSON.parse(request.init.body)
  const base = START_PLAN_SYSTEM_BLOCKS[2]
  assert.deepEqual(body.system[2], { ...base, text: base.text + '\n\nS1\n\nS2\n\nS3' })
  assert.deepEqual(body.messages, [userMessage], '所有 system 消息都必须从 body.messages 中剔除')
  assert.deepEqual(START_PLAN_SYSTEM_BLOCKS, EVIDENCE.system, 'START_PLAN_SYSTEM_BLOCKS 不得被请求修改')
})

test('stream 请求体：canonical 模型 id 与未知 id 原样', async () => {
  for (const [input, expected] of [
    ['glm-5.3-flash', 'GLM-5.3-Flash'],
    ['glm-5.2', 'GLM-5.2'],
    ['glm-5-turbo', 'GLM-5-Turbo'],
    ['custom-model', 'custom-model'],
  ]) {
    const request = await requestFor(makeAdapter(), { model: input })
    assert.equal(JSON.parse(request.init.body).model, expected, input)
  }
})

test('stream 请求体：max_tokens 按模型上限缺省、保留与截断', async () => {
  for (const [model, maxTokens, expected, label] of [
    ['glm-5.3-flash', undefined, 128000, 'glm-5.3-flash 缺省'],
    ['glm-5.3-flash', 256, 256, 'glm-5.3-flash 显式 256 保留'],
    ['glm-5.3-flash', 128000, 128000, 'glm-5.3-flash 显式等于上限'],
    ['glm-5.3-flash', 128001, 128000, 'glm-5.3-flash 超上限截断'],
    ['glm-5.2', undefined, 128000, 'glm-5.2 缺省'],
    ['glm-5-turbo', undefined, 64000, 'glm-5-turbo 缺省 64000'],
    ['glm-5-turbo', 32000, 32000, 'glm-5-turbo 显式 32000 保留'],
    ['glm-5-turbo', 128000, 64000, 'glm-5-turbo 显式 128000 截断到 64000'],
    ['custom-model', undefined, 16384, '未知模型缺省 16384'],
    ['custom-model', 32000, 16384, '未知模型超上限截断到 16384'],
  ]) {
    const options = { model }
    if (maxTokens !== undefined) options.maxTokens = maxTokens
    const request = await requestFor(makeAdapter(), options)
    assert.equal(JSON.parse(request.init.body).max_tokens, expected, label)
  }
})

test('stream 请求体：output_config.effort 默认 low、显式 high/max 透传', async () => {
  for (const [reasoningEffort, expected] of [
    [undefined, 'low'],
    ['low', 'low'],
    ['high', 'high'],
    ['max', 'max'],
  ]) {
    const request = await requestFor(makeAdapter(), reasoningEffort === undefined ? {} : { reasoningEffort })
    assert.deepEqual(JSON.parse(request.init.body).output_config, { effort: expected })
  }
})

test('stream 请求体：tools 映射 input_schema、stop 映射 stop_sequences', async () => {
  const tools = [{
    name: 'get_weather', description: '查询天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }]
  const request = await requestFor(makeAdapter(), { tools, stop: ['DONE'] })
  const body = JSON.parse(request.init.body)
  assert.deepEqual(body.tools, [{ name: 'get_weather', description: '查询天气', input_schema: tools[0].parameters }])
  assert.deepEqual(body.stop_sequences, ['DONE'])
  assert.equal('stop' in body, false)
})

test('两次调用重新生成 session/query/request/trace ID', async () => {
  const calls = await runStreams(makeAdapter(), {}, 2)
  const requests = calls.filter((call) => String(call.url) === START_PLAN_ENDPOINT)
  assert.equal(requests.length, 2)
  const idValues = requests.map((request) => ID_HEADERS.map((name) => header(request.init.headers, name)))
  for (const ids of idValues) {
    for (const id of ids) assert.match(String(id), UUID_RE)
  }
  const flat = idValues.flat()
  assert.equal(new Set(flat).size, flat.length, '每次调用的 session/query/request/trace id 都必须重新生成且两两不同')
  assert.notEqual(idValues[0][0], idValues[1][0], '两次调用的 x-session-id 必须不同')
  for (let index = 0; index < requests.length; index++) {
    const body = JSON.parse(requests[index].init.body)
    assert.equal(JSON.parse(body.metadata.user_id).session_id, header(requests[index].init.headers, 'x-session-id'))
  }
})

test('deviceMid 缺失时回退 readDevice，且只读取一次', async () => {
  let reads = 0
  const adapter = new GiftModelAdapter({
    getModels: () => [],
    resolveAuth: async () => ({ token: TOKEN }),
    readDevice: async () => { reads++; return 'device-from-reader' },
  })
  const request = await requestFor(adapter)
  assert.equal(reads, 1)
  assert.equal(header(request.init.headers, 'x-device-mid'), 'device-from-reader')
  const body = JSON.parse(request.init.body)
  assert.equal(JSON.parse(body.metadata.user_id).device_id, 'device-from-reader')
})

test('resolveAuth 已提供 deviceMid 时不调用 readDevice', async () => {
  let reads = 0
  const adapter = new GiftModelAdapter({
    getModels: () => [],
    resolveAuth: async () => ({ token: TOKEN, deviceMid: DEVICE }),
    readDevice: async () => { reads++; return 'unexpected-device' },
  })
  const request = await requestFor(adapter)
  assert.equal(reads, 0)
  assert.equal(header(request.init.headers, 'x-device-mid'), DEVICE)
})

test('token 与 device 都缺时 MISSING_CREDENTIAL 且不发起请求', async () => {
  const cases = [
    { name: '缺少 device', resolveAuth: async () => ({ token: TOKEN }), readDevice: async () => undefined },
    { name: 'token 与 device 都缺', resolveAuth: async () => ({}), readDevice: async () => undefined },
    { name: '凭据解析失败', resolveAuth: async () => { throw new Error('no session') }, readDevice: async () => DEVICE },
  ]
  for (const testCase of cases) {
    let fetchCalls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => { fetchCalls++; return sseResponse(packets) }
    try {
      const adapter = new GiftModelAdapter({ getModels: () => [], resolveAuth: testCase.resolveAuth, readDevice: testCase.readDevice })
      await assert.rejects(async () => {
        for await (const _chunk of adapter.stream({ provider: GIFT_PROVIDER, model: 'glm-5.3-flash', messages: [] })) { /* 不应产生任何 chunk */ }
      }, (error) => {
        assert.equal(error.code, 'MISSING_CREDENTIAL', testCase.name)
        return true
      })
      assert.equal(fetchCalls, 0, testCase.name + ' 时不得发起网络请求')
    } finally {
      globalThis.fetch = realFetch
    }
  }
})
