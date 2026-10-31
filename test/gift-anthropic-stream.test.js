import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { GiftModelAdapter, GIFT_PROVIDER } from '../lib/zcode/gift-adapter.mjs'
import { START_PLAN_SYSTEM_BLOCKS } from '../lib/zcode/start-plan-context.mjs'

const ENDPOINT = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'
const event = (value) => 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n'

function header(headers, name) {
  const target = name.toLowerCase()
  if (headers instanceof Headers) return headers.get(target)
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

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

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream({ provider: GIFT_PROVIDER, messages: [], ...options })) chunks.push(chunk)
  return chunks
}

function adapter() {
  return new GiftModelAdapter({
    getModels: () => [],
    resolveAuth: async () => ({ token: 'synthetic-zcode-jwt', deviceMid: 'synthetic-device-mid' }),
  })
}

test('Start Plan 3012 返回明确接入诊断且不误判额度耗尽', async () => {
  const realFetch = globalThis.fetch
  for (const status of [200, 405]) {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ code: 3012, msg: 'request has been blocked due to unusual activity.', logid: 'test-request-3012' }), {
        status, headers: { 'content-type': 'application/json' },
      })
    }
    try {
      await assert.rejects(collect(adapter(), { model: 'glm-5.3-flash' }), (error) => {
        assert.equal(error.bizCode, 3012, 'HTTP ' + status + ' 业务码')
        assert.equal(error.status, status)
        assert.equal(error.requestId, 'test-request-3012')
        assert.notEqual(error.code, 'QUOTA')
        assert.match(error.message, /官方客户端/)
        assert.match(error.message, /第三方接入/)
        return true
      })
      assert.equal(calls, 1, '3012 不得触发身份或请求头轮换重试')
    } finally { globalThis.fetch = realFetch }
  }
})


test('空 SSE 必须拒绝，不能报告 finish:stop', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse([])
  try {
    await assert.rejects(collect(adapter(), { model: 'glm-5.3-flash' }), /message_start/i)
  } finally {
    globalThis.fetch = realFetch
  }
})

const messageStart = () => event({ type: 'message_start', message: { id: 'msg-mock', role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } })
const messageDelta = (stopReason = 'end_turn') => event({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } })
const messageStop = () => event({ type: 'message_stop' })
const invalidStreams = [
  ['只有 keepalive', [': keepalive\n\n', event({ type: 'ping' })], /message_start/i],
  ['畸形 JSON', [messageStart(), 'data: {broken\n\n', messageDelta(), messageStop()], /JSON/i],
  ['末尾无换行畸形 JSON', [messageStart(), messageDelta(), 'data: {broken'], /JSON/i],
  ['畸形 JSON 事件形状', [messageStart(), 'data: null\n\n', messageDelta(), messageStop()], /event|事件/i],
  ['缺少 message_start', [messageDelta(), messageStop()], /message_start/i],
  ['无效 message_start', [event({ type: 'message_start', message: {} }), messageDelta(), messageStop()], /message_start/i],
  ['重复 message_start', [messageStart(), messageStart(), messageDelta(), messageStop()], /message_start/i],
  ['截断缺 message_stop', [messageStart(), messageDelta()], /message_stop/i],
  ['DONE 不能替代 message_stop', [messageStart(), messageDelta(), 'data: [DONE]\n\n'], /message_stop/i],
  ['未关闭 block', [messageStart(), event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), messageDelta(), messageStop()], /block/i],
  ['缺少 stop_reason', [messageStart(), messageStop()], /stop_reason/i],
  ['未知 stop_reason', [messageStart(), messageDelta('future_reason'), messageStop()], /stop_reason/i],
]

for (const [name, packets, error] of invalidStreams) {
  test(name + ' 必须拒绝且不能生成成功 finish', async () => {
    const realFetch = globalThis.fetch
    const emitted = []
    globalThis.fetch = async () => sseResponse(packets)
    try {
      await assert.rejects(async () => {
        for await (const chunk of adapter().stream({ provider: GIFT_PROVIDER, model: 'glm-5.3-flash', messages: [] })) emitted.push(chunk)
      }, error)
      assert.equal(emitted.some((chunk) => chunk.type === 'finish'), false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

function trackedSignal() {
  const controller = new AbortController()
  const listeners = new Set()
  const signal = {
    get aborted() { return controller.signal.aborted },
    addEventListener(type, listener, options) {
      if (type === 'abort') listeners.add(listener)
      controller.signal.addEventListener(type, listener, options)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener)
      controller.signal.removeEventListener(type, listener)
    },
  }
  return { signal, listeners, abort: () => controller.abort() }
}

function trackedResponse(packets, { contentType = 'text/event-stream', status = 200, readError, cleanupErrors = false } = {}) {
  const calls = { cancel: 0, release: 0, bodyCancel: 0 }
  let index = 0
  const reader = {
    async read() {
      if (readError) throw readError
      return index < packets.length ? { done: false, value: new TextEncoder().encode(packets[index++]) } : { done: true }
    },
    async cancel() { calls.cancel++; if (cleanupErrors) throw new Error('cancel cleanup failure') },
    releaseLock() { calls.release++; if (cleanupErrors) throw new Error('release cleanup failure') },
  }
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    body: { getReader: () => reader, async cancel() { calls.bodyCancel++ } },
    async text() { return packets.join('') },
  }
  return { response, calls }
}

for (const [name, packets, config, error] of [
  ['HTTP错误', ['denied'], { status: 403 }, /HTTP 403/],
  ['HTTP200业务错误', ['{"code":1005,"msg":"quota"}'], { contentType: 'application/json' }, /code 1005/],
  ['非SSE响应', ['plain'], { contentType: 'text/plain' }, /SSE/],
  ['读取失败', [], { readError: new Error('read failed') }, /读取失败/],
  ['SSE错误', [event({ type: 'error', error: { type: 'overloaded_error', message: 'upstream failed' } })], {}, /上游错误/],
  ['清理失败不覆盖协议错误', ['data: {bad\n\n'], { cleanupErrors: true }, /JSON/],
]) {
  test(name + ' 清理 abort listener 和响应 reader', async () => {
    const realFetch = globalThis.fetch
    const tracked = trackedSignal()
    const { response, calls } = trackedResponse(packets, config)
    globalThis.fetch = async () => response
    try {
      await assert.rejects(collect(adapter(), { model: 'glm-5.3-flash', signal: tracked.signal }), error)
      assert.equal(tracked.listeners.size, 0)
      assert.equal(calls.cancel, 1)
      assert.equal(calls.release, 1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

test('HTTP 鉴权、额度耗尽与速率限制保持不同错误码', async () => {
  const realFetch = globalThis.fetch
  try {
    for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [402, 'QUOTA'], [429, 'RATE_LIMIT']]) {
      const { response } = trackedResponse(['denied'], { status, contentType: 'application/json' })
      globalThis.fetch = async () => response
      await assert.rejects(collect(adapter(), { model: 'glm-5.3-flash' }), (error) => error.code === code, String(status))
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

async function runLifecycleMode(mode) {
  const realFetch = globalThis.fetch
  const tracked = trackedSignal()
  const { response, calls } = trackedResponse([
    messageStart(),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_stop', index: 0 }),
    messageDelta(), messageStop(),
  ])
  let fetchCalls = 0
  globalThis.fetch = async (_url, init) => {
    fetchCalls++
    if (mode === 'fetch-error') throw new Error('fetch failed')
    if (mode === 'headers-error') response.headers.get = () => { throw new Error('headers failed') }
    if (mode === 'reader-error') response.body.getReader = () => { throw new Error('reader failed') }
    if (mode === 'response-abort') {
      response.headers = new Headers({ 'content-type': 'application/json' })
      response.body.getReader = () => ({
        async read() {
        tracked.abort()
        init.signal.throwIfAborted()
        },
        async cancel() {},
        releaseLock() {},
      })
    }
    return response
  }
  try {
    const options = { provider: GIFT_PROVIDER, model: 'glm-5.3-flash', messages: [], signal: tracked.signal }
    if (mode === 'pre-abort') tracked.abort()
    if (mode.endsWith('-error')) {
      await assert.rejects(collect(adapter(), options), /读取失败/)
    } else if (mode === 'consumer-return') {
      for await (const chunk of adapter().stream(options)) {
        assert.equal(chunk.type, 'block-start')
        break
      }
    } else {
      const chunks = []
      for await (const chunk of adapter().stream(options)) {
        chunks.push(chunk)
        if (mode === 'abort' && chunk.type === 'block-start') tracked.abort()
      }
      assert.equal(chunks.at(-1).reason.kind, mode.includes('abort') ? 'aborted' : 'stop', mode + ' 终止原因')
    }
    assert.equal(tracked.listeners.size, 0, mode + ' 必须移除 abort 监听')
    if (['complete', 'consumer-return', 'abort'].includes(mode)) {
      assert.equal(calls.cancel, 1, mode + ' 必须取消 reader')
      assert.equal(calls.release, 1, mode + ' 必须释放 reader')
    } else if (['headers-error', 'reader-error', 'response-abort'].includes(mode)) {
      assert.equal(calls.bodyCancel, 1, mode + ' 必须取消响应体')
    }
    if (mode === 'pre-abort') assert.equal(fetchCalls, 0)
  } catch (error) {
    error.message = '[' + mode + '] ' + error.message
    throw error
  } finally {
    globalThis.fetch = realFetch
  }
}

test('完整完成 / 消费者提前返回 / 取消：移除监听并释放资源', async () => {
  for (const mode of ['complete', 'consumer-return', 'abort']) await runLifecycleMode(mode)
})

test('预取消 / fetch / 响应头 / reader / 响应体失败：移除监听并释放资源', async () => {
  for (const mode of ['pre-abort', 'fetch-error', 'headers-error', 'reader-error', 'response-abort']) await runLifecycleMode(mode)
})


test('fetch 挂起期间取消仍清理监听且返回 aborted', async () => {
  const realFetch = globalThis.fetch
  const tracked = trackedSignal()
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    queueMicrotask(() => tracked.abort())
  })
  try {
    const chunks = await collect(adapter(), { model: 'glm-5.3-flash', signal: tracked.signal })
    assert.deepEqual(chunks.map((chunk) => chunk.reason?.kind), ['aborted'])
    assert.equal(tracked.listeners.size, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('提前返回 / 解析错误：取消真实 ReadableStream 并解锁 reader', async () => {
  for (const mode of ['consumer-return', 'parse-error']) {
    const realFetch = globalThis.fetch
    const tracked = trackedSignal()
    let cancellations = 0
    const body = new ReadableStream({
      start(controller) {
        const packet = mode === 'parse-error' ? 'data: {bad\n\n'
          : messageStart() + event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        controller.enqueue(new TextEncoder().encode(packet))
        // 故意保持网络流打开，不能依赖 EOF 自动关闭资源。
      },
      cancel() { cancellations++ },
    })
    globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    try {
      const options = { model: 'glm-5.3-flash', signal: tracked.signal }
      if (mode === 'parse-error') await assert.rejects(collect(adapter(), options), /JSON/)
      else for await (const _chunk of adapter().stream(options)) break
      assert.equal(cancellations, 1, mode + ' 必须取消流')
      assert.equal(body.locked, false, mode + ' 必须解锁 reader')
      assert.equal(tracked.listeners.size, 0, mode + ' 必须移除监听')
    } catch (error) {
      error.message = '[' + mode + '] ' + error.message
      throw error
    } finally {
      globalThis.fetch = realFetch
    }
  }
})


for (const { name, start, delta, expected } of [
  {
    name: '真实响应 start 0/0、delta 924/14 应汇总 938 并正常 stop',
    start: { input_tokens: 0, output_tokens: 0 },
    delta: { input_tokens: 924, output_tokens: 14, cache_read_input_tokens: 0 },
    expected: { inputTokens: 924, outputTokens: 14, totalTokens: 938 },
  },
  {
    name: 'delta 的合法零值覆盖已有输入、输出和缓存计数',
    start: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 },
    delta: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    expected: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  },
  {
    name: 'delta 的无效用量值不覆盖已有计数',
    start: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 },
    delta: { input_tokens: null, output_tokens: -1, cache_read_input_tokens: '0', cache_creation_input_tokens: false },
    expected: { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadTokens: 7, cacheWriteTokens: 5 },
  },
]) {
  test(name, async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => sseResponse([
      event({ type: 'message_start', message: { id: 'msg-usage', role: 'assistant', content: [], usage: start } }),
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }),
      messageStop(),
    ])
    try {
      const chunks = await collect(adapter(), { model: 'glm-5.3-flash' })
      assert.deepEqual(chunks, [
        { type: 'usage', usage: expected },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

test('thinking、缓存 usage、stop_sequence 和多行 CRLF SSE 保持正常', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse([
    ': heartbeat\r\n\r\n',
    event({ type: 'message_start', message: { id: 'msg-thinking', role: 'assistant', content: [], usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 } } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    'event: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "index":0,"delta":{"type":"thinking_delta","thinking":"先推理"}}\r\n\r\n',
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mock' } }),
    event({ type: 'content_block_stop', index: 0 }),
    messageDelta('stop_sequence'),
    messageStop().trimEnd(),
  ])
  try {
    const chunks = await collect(adapter(), { model: 'glm-5.3-flash' })
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '先推理' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先推理' } },
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadTokens: 7, cacheWriteTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  } finally {
    globalThis.fetch = realFetch
  }
})

const require = createRequire(import.meta.url)
let llmEntry = process.env.DSH_LLM_ENTRY || null
if (!llmEntry) {
  try { llmEntry = require.resolve('@deepseek-ai/dsh-llm') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    if (process.resourcesPath) {
      llmEntry = require.resolve('@deepseek-ai/dsh-llm', { paths: [path.join(process.resourcesPath, 'app.asar', 'dsh')] })
    }
  }
}
const { LlmRuntime } = llmEntry ? await import(pathToFileURL(llmEntry).href) : {}

function minimalContext() {
  return {
    effect(setup) {
      const iterator = setup()
      const { value: dispose } = iterator.next()
      return () => dispose()
    },
    waterfall: (_runtime, _event, _options, dispatch) => dispatch(),
    events: { dispatch: () => [] },
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
  }
}

test('真实 LlmRuntime 将不完整/无效流变成 finish:error，而非 stop', {
  skip: !llmEntry && '普通 Node 未找到真实 dsh-llm；使用本机 Electron 或 DSH_LLM_ENTRY 验证',
}, async (t) => {
  const runtime = new LlmRuntime(minimalContext())
  const dispose = runtime.registerAdapter([GIFT_PROVIDER], adapter())
  const realFetch = globalThis.fetch
  try {
    for (const [name, packets, expected] of [['空 SSE', [], /message_start/i], ...invalidStreams]) {
      await t.test(name, async () => {
        let fetchCalls = 0
        globalThis.fetch = async (_url, init) => {
          fetchCalls++
          assert.equal(JSON.parse(init.body).model, 'GLM-5.3-Flash')
          return sseResponse(packets)
        }
        const prepared = await runtime.prepareCall({ provider: GIFT_PROVIDER, model: 'glm-5.3-flash' })
        const chunks = []
        // prepared.config 包含 provider/model/maxTokens，不能只传 messages。
        for await (const chunk of prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'mock only' }] }] })) chunks.push(chunk)
        assert.equal(fetchCalls, 1)
        const finishes = chunks.filter((chunk) => chunk.type === 'finish')
        assert.equal(finishes.length, 1)
        assert.equal(finishes[0].reason.kind, 'error')
        assert.match(finishes[0].reason.failure.message, expected)
      })
    }
  } finally {
    globalThis.fetch = realFetch
    dispose()
  }
})

test('GiftModelAdapter 经真实 LlmRuntime 注册并进入模型目录', {
  skip: !llmEntry && '普通 Node 未找到真实 dsh-llm；可设置 DSH_LLM_ENTRY',
}, async () => {
  const runtime = new LlmRuntime(minimalContext())
  const registered = new GiftModelAdapter({
    getModels: () => [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }],
    resolveAuth: async () => { throw new Error('本测试不发起模型请求') },
  })
  const dispose = runtime.registerAdapter([GIFT_PROVIDER], registered)
  try {
    assert.equal(typeof dispose, 'function')
    assert.deepEqual(runtime.listProviders(), [{ id: GIFT_PROVIDER, name: '智谱 · 赠送' }])
    assert.deepEqual(await runtime.listModels(GIFT_PROVIDER), [{
      provider: GIFT_PROVIDER,
      id: 'glm-5.3-flash',
      name: 'GLM 5.3 Flash',
      description: '赠送额度（ZCode Start Plan）',
      inputModalities: ['text'],
    }])
    // 分发前的 prepareCall 也必须存在；只验证构造，不发起真实模型请求。
    const flash = await runtime.prepareCall({ provider: GIFT_PROVIDER, model: 'glm-5.3-flash' })
    assert.equal(flash.config.provider, GIFT_PROVIDER)
    assert.equal(flash.config.model, 'glm-5.3-flash')
    assert.equal(flash.config.maxTokens, 128000)
    assert.equal(flash.context.contextWindow, 1000000)
    assert.equal(typeof flash.stream, 'function')
    // glm-5-turbo 的输出上限与上下文窗口按官方 modelConfigRules 区分。
    const turbo = await runtime.prepareCall({ provider: GIFT_PROVIDER, model: 'glm-5-turbo' })
    assert.equal(turbo.config.maxTokens, 64000)
    assert.equal(turbo.context.contextWindow, 200000)
  } finally {
    dispose()
  }
})
test('Anthropic block 生命周期组装文本、tool_use、usage，并生成规范请求', async () => {
  let captured
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    const packets = [
      event({ type: 'message_start', message: { id: 'msg-tool', role: 'assistant', content: [], usage: { input_tokens: 23, output_tokens: 0 } } }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先查天气' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-weather', name: 'get_weather', input: {} } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }),
      event({ type: 'content_block_stop', index: 1 }),
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      event({ type: 'message_stop' }),
    ]
    // 故意跨网络 chunk 拆开一条 data 行，验证 SSE 缓冲后再组装事件。
    return sseResponse([packets.slice(0, 5).join(''), packets[5].slice(0, 40), packets[5].slice(40) + packets.slice(6).join('')])
  }
  try {
    const chunks = await collect(adapter(), {
      model: 'glm-5.3-flash',
      system: '保持简洁',
      maxTokens: 256,
      stop: ['DONE'],
      messages: [{ role: 'user', content: [{ type: 'text', text: '巴黎天气？' }] }],
      tools: [{
        name: 'get_weather', description: '查询天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    })

    assert.equal(String(captured.url), ENDPOINT)
    assert.equal(captured.init.method, 'POST')
    const headers = captured.init.headers
    assert.equal(header(headers, 'authorization'), 'Bearer synthetic-zcode-jwt')
    assert.equal(header(headers, 'x-api-key'), 'synthetic-zcode-jwt')
    assert.equal(header(headers, 'anthropic-version'), '2023-06-01')
    assert.equal(header(headers, 'x-device-mid'), 'synthetic-device-mid')
    assert.equal(header(headers, 'x-zcode-app-version'), '3.17.1')
    assert.equal(header(headers, 'x-title'), 'DSH')
    assert.match(String(header(headers, 'user-agent')), /^dsh-model-usage\//)
    for (const name of ['x-session-id', 'x-query-id', 'x-request-id', 'x-zcode-trace-id']) {
      assert.match(String(header(headers, name)), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, name)
    }
    const body = JSON.parse(captured.init.body)
    assert.equal(body.model, 'GLM-5.3-Flash')
    assert.equal(body.max_tokens, 256)
    assert.equal(body.stream, true)
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.deepEqual(body.output_config, { effort: 'low' })
    assert.equal(body.system.length, 3)
    assert.deepEqual(body.system.slice(0, 2), START_PLAN_SYSTEM_BLOCKS.slice(0, 2))
    assert.deepEqual(body.system[2], {
      ...START_PLAN_SYSTEM_BLOCKS[2],
      text: START_PLAN_SYSTEM_BLOCKS[2].text + '\n\n保持简洁',
    })
    const metadata = JSON.parse(body.metadata.user_id)
    assert.equal(metadata.device_id, header(headers, 'x-device-mid'))
    assert.equal(metadata.account_uuid, '')
    assert.equal(metadata.session_id, header(headers, 'x-session-id'))
    assert.equal('temperature' in body, false)
    assert.equal('top_p' in body, false)
    assert.deepEqual(body.stop_sequences, ['DONE'])
    assert.deepEqual(body.tools, [{
      name: 'get_weather', description: '查询天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }])
    assert.equal('stream_options' in body, false)
    assert.equal('stop' in body, false)

    assert.deepEqual(chunks.map((chunk) => chunk.type), [
      'block-start', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'tool-call-delta', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: '先查天气' })
    assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'text', text: '先查天气' } })
    assert.deepEqual(chunks[4], {
      type: 'tool-call-delta', index: 1, id: 'toolu-weather', name: 'get_weather', argumentsDelta: '',
    })
    assert.deepEqual(chunks[7], {
      type: 'block-end', index: 1,
      block: { type: 'tool-call', id: 'toolu-weather', name: 'get_weather', arguments: '{"city":"Paris"}' },
    })
    assert.deepEqual(chunks[8], { type: 'usage', usage: { inputTokens: 23, outputTokens: 9, totalTokens: 32 } })
    assert.deepEqual(chunks[9], { type: 'finish', reason: { kind: 'tool-calls' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('DSH 宿主会话：system 消息并入第三块且不重复进入 messages', async () => {
  let captured
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return sseResponse([messageStart(), messageDelta(), messageStop()])
  }
  try {
    const chunks = await collect(adapter(), {
      model: 'glm-5.3-flash',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '宿主系统提示' }] },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
    })
    const body = JSON.parse(captured.init.body)
    assert.equal(body.system.length, 3)
    assert.deepEqual(body.system.slice(0, 2), START_PLAN_SYSTEM_BLOCKS.slice(0, 2))
    assert.deepEqual(body.system[2], {
      ...START_PLAN_SYSTEM_BLOCKS[2],
      text: START_PLAN_SYSTEM_BLOCKS[2].text + '\n\n宿主系统提示',
    })
    assert.deepEqual(body.system[2].cache_control, { type: 'ephemeral' })
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('未知模型 id 原样保留，缺省 max_tokens 为 16384', async () => {
  let captured
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return sseResponse([
      event({ type: 'message_start', message: { id: 'msg-length', role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
      event({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } }),
      event({ type: 'message_stop' }),
    ])
  }
  try {
    const model = '  custom-model  '
    const chunks = await collect(adapter(), { model })
    const body = JSON.parse(captured.init.body)
    assert.equal(body.model, model)
    assert.equal(body.max_tokens, 16384)
    assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

// 结束事件是消息边界，连接可继续保活，后续字节不属于本次生成。
test('message_stop 立即完成并取消保活流，忽略结束后的字节', { timeout: 2000 }, async () => {
  const realFetch = globalThis.fetch
  let cancellations = 0
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(messageStart() + messageDelta() + messageStop() + 'data: {broken\n\n'))
    },
    cancel() { cancellations++ },
  })
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.redirect, 'error')
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const chunks = await collect(adapter(), {})
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(cancellations, 1)
    assert.equal(body.locked, false)
  } finally { globalThis.fetch = realFetch }
})

test('凭据解析、fetch、HTTP、业务错误和 SSE 错误均不回显凭据', async () => {
  const realFetch = globalThis.fetch
  const secret = 'synthetic-zcode-jwt'
  const failures = [
    () => { throw new Error('authorization: Bearer ' + secret) },
    () => new Response(secret, { status: 403 }),
    () => new Response(JSON.stringify({ code: 3012, logid: secret }), { status: 405 }),
    () => new Response(JSON.stringify({ code: 1005, msg: secret }), { headers: { 'content-type': 'application/json' } }),
    () => sseResponse([event({ type: 'error', error: { type: 'authentication_error', message: secret } })]),
  ]
  try {
    for (const failure of failures) {
      globalThis.fetch = async () => failure()
      await assert.rejects(collect(adapter(), {}), (error) => {
        assert.equal(String(error.stack).includes(secret), false)
        assert.equal(error.cause, undefined)
        return true
      })
    }
    const brokenAuth = new GiftModelAdapter({ getModels: () => [], resolveAuth: failures[0] })
    await assert.rejects(collect(brokenAuth, {}), (error) => error.code === 'MISSING_CREDENTIAL' && !error.message.includes(secret))
  } finally { globalThis.fetch = realFetch }
})

test('SSE 超长行、多行事件与累积 block 有界拒绝并清理', async () => {
  const realFetch = globalThis.fetch
  const delta = event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(512 * 1024) } })
  for (const packets of [
    ['data: ' + 'x'.repeat(1024 * 1024)],
    Array.from({ length: 3 }, () => 'data: ' + 'x'.repeat(512 * 1024) + '\n'),
    [messageStart(), event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), ...Array(17).fill(delta)],
  ]) {
    const { response, calls } = trackedResponse(packets)
    globalThis.fetch = async () => response
    try {
      await assert.rejects(collect(adapter(), {}), /大小限制/)
      assert.equal(calls.cancel, 1)
      assert.equal(calls.release, 1)
    } finally { globalThis.fetch = realFetch }
  }
})

test('正在等待无数据流时取消仍能结束', { timeout: 2000 }, async () => {
  const realFetch = globalThis.fetch
  const ctl = new AbortController()
  let cancellations = 0
  const body = new ReadableStream({
    pull() { queueMicrotask(() => ctl.abort()) },
    cancel() { cancellations++ },
  })
  globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  try {
    const chunks = await collect(adapter(), { signal: ctl.signal })
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.equal(cancellations, 1)
    assert.equal(body.locked, false)
  } finally { globalThis.fetch = realFetch }
})
