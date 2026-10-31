import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import {
  START_PLAN_ORIGIN,
  START_PLAN_ENDPOINT,
  START_PLAN_APP_VERSION,
  composeStartPlanSystem,
} from './start-plan-context.mjs'

// ---------------------------------------------------------------- 请求构造
// 按需读取设备标识，避免营销客户端复用响应读取函数时形成静态循环依赖。
const readDeviceMid = async () => (await import('./marketing.mjs')).readDeviceMid()

// 只有本地构造的诊断可展示；fetch/凭据读取/上游正文可能包含令牌。
class GiftRequestError extends Error {
  constructor(message, code = 'UNKNOWN') {
    super(message)
    this.code = code
  }
}
const MAX_SSE_EVENT_CHARS = 1024 * 1024
const MAX_BLOCK_CHARS = 8 * 1024 * 1024

// dsh-model-usage · GLM 赠送额度模型适配器（独立路由 glm-gift）
// Start Plan 官方运行时：POST /api/v1/zcode-plan/anthropic/v1/messages。
// 鉴权使用 ZCode JWT（不是 BigModel OAuth access_token），并同时发送 Authorization 与 x-api-key。
// 请求形状按 2026-10-31 独立 HTTP 验证结果构造（见 lib/zcode/start-plan-context.mjs 与
// docs/start-plan-direct.md）：完整客户端请求头 + 已验证 system 三块 + thinking/output_config。
// 响应为 Anthropic SSE：text/thinking/tool_use 分片统一翻译成 dsh-llm 的 StreamChunk。
export const GIFT_PROVIDER = 'glm-gift'

// ZCode 官方内置 modelConfigRules：GLM-5.3-Flash/GLM-5.2 为 1,000,000 / 128,000，
// GLM-5-Turbo 为 200,000 / 64,000，未知模型保守取 128,000 / 16,384。
// 适配器无法把 DSH 附件字节转成 Anthropic 图片块，故 GLM 系列声明 text-only，由 DSH 投影占位文本。
const MAX_OUTPUT_TOKENS = 128000
const MODEL_META = {
  contextWindow: 1000000,
  defaultMaxTokens: MAX_OUTPUT_TOKENS,
  inputModalities: ['text'],
}
const TURBO_META = {
  contextWindow: 200000,
  defaultMaxTokens: 64000,
  inputModalities: ['text'],
}
const DEFAULT_META = {
  contextWindow: 128000,
  defaultMaxTokens: 16384,
  inputModalities: ['text'],
}

// 插件包版本只用于 user-agent 标识；读取失败回退 1.3.0，不能让版本元数据影响请求。
const PACKAGE_VERSION = (() => {
  try {
    const version = createRequire(import.meta.url)('../../package.json').version
    return typeof version === 'string' && version ? version : '1.3.0'
  } catch { return '1.3.0' }
})()

// 已验证请求使用 thinking 开启 + output_config.effort；只认 low/high/max，其它值回落 low。
const EFFORT_LEVELS = ['low', 'high', 'max']
const OS_CATEGORY = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
const OS_VERSION = (() => {
  try { return release() } catch { return '' }
})()
const RUNTIME_LOCALE = (() => {
  try {
    const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions()
    return { locale: locale || '', timeZone: timeZone || '' }
  } catch { return { locale: '', timeZone: '' } }
})()

function metaFor(model) {
  const id = String(model || '').trim()
  if (/^glm-5-turbo/i.test(id)) return TURBO_META
  return /^glm-/i.test(id) ? MODEL_META : DEFAULT_META
}

// ZCode Start Plan 使用官方 canonical 模型 id；已知 id 做大小写/空白归一，未知模型原样保留。
const CANONICAL_MODEL_IDS = new Map([
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-5.2', 'GLM-5.2'],
  ['glm-5-turbo', 'GLM-5-Turbo'],
])
function canonicalModelId(model) {
  return CANONICAL_MODEL_IDS.get(String(model ?? '').trim().toLowerCase()) ?? model
}

/** max_tokens 取 1..当前模型输出上限的整数；缺失或非法值回退该模型默认上限。 */
function clampMaxTokens(value, limit) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return limit
  return Math.min(n, limit)
}

/** 调用方 system 归一为文本：string 直接用，数组只取 text 块。 */
function systemText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/**
 * DSH 真实会话不设置 GenerateOptions.system：系统提示词以 role='system' 消息放在 messages 里
 * （dsh-agent-loop 的 SystemPromptProjection）。这里按 dsh-llm-deepseek 同口径取文本：
 * 同一条 system 消息内的 text 块直接拼接，多条 system 消息之间用空行分隔，空白内容忽略。
 */
function historySystemText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (!message || message.role !== 'system') continue
    const content = message.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    }
    if (text.trim()) parts.push(text)
  }
  return parts.join('\n\n')
}

/** 已验证的请求头（键全小写）；仅会话/查询/请求/追踪 4 个 ID 每次调用重新生成。 */
function startPlanHeaders({ token, device, sessionId, queryId, requestId, traceId }) {
  return {
    authorization: 'Bearer ' + token,
    'x-api-key': token,
    'user-agent': 'dsh-model-usage/' + PACKAGE_VERSION,
    'x-title': 'DSH',
    'x-zcode-agent': 'dsh',
    'http-referer': START_PLAN_ORIGIN,
    'x-zcode-app-version': START_PLAN_APP_VERSION,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-device-mid': device,
    'x-platform': process.platform + '-' + process.arch,
    'x-client-language': RUNTIME_LOCALE.locale,
    'x-client-timezone': RUNTIME_LOCALE.timeZone,
    'x-os-version': OS_VERSION,
    'x-os-category': OS_CATEGORY,
    'x-release-channel': 'production',
    'x-zcode-session-type': 'main',
    'x-zcode-query-source': 'main_turn',
    'x-session-id': sessionId,
    'x-query-id': queryId,
    'x-request-id': requestId,
    'x-zcode-trace-id': traceId,
  }
}

/** 3012 只说明直连被拒绝；不得误报为额度耗尽或推断特定验证材料缺失。 */
function startPlanAccessError(status, text, secrets) {
  let body
  try { body = JSON.parse(text) } catch { return null }
  if (!body || Number(body.code) !== 3012) return null
  const requestId = typeof body.logid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.logid) && !secrets.some((secret) => body.logid.includes(secret)) ? body.logid : undefined
  const error = new GiftRequestError('ZCode Start Plan 拒绝了插件直连（3012）。这不代表赠额耗尽；请在官方客户端使用该额度，或取得官方支持的第三方接入方式。' + (requestId ? ' 请求定位号：' + requestId : ''))
  error.code = 'UNKNOWN'
  error.bizCode = 3012
  error.status = status
  if (requestId) error.requestId = requestId
  return error
}

export class GiftModelAdapter {
  constructor({ getModels, resolveAuth, readDevice, providerName }) {
    this.getModels = getModels
    this.resolveAuth = resolveAuth
    // deviceMid 默认只读复用本机 ZCode 桌面端记录；测试/宿主可注入 readDevice 覆盖。
    this.readDevice = typeof readDevice === 'function' ? readDevice : readDeviceMid
    // 分组名由 Host 按关联 GLM provider 同步生成（「<GLM 名称> · 赠送」）；注册/替换时读取。
    const resolveName = typeof providerName === 'function' ? providerName : () => providerName
    this.providerName = () => {
      const name = resolveName && resolveName()
      return typeof name === 'string' && name.trim() ? name.trim() : '智谱 · 赠送'
    }
  }

  providerInfo(provider) {
    return { id: provider, name: this.providerName() }
  }

  providerRetryPolicy(_provider) {}

  async listModels(provider) {
    const models = (await Promise.resolve(this.getModels())) || []
    return (Array.isArray(models) ? models : []).filter((m) => m && typeof m.id === 'string' && m.id.trim()).map((m) => ({
      provider,
      id: m.id,
      name: m.name || m.id,
      description: '赠送额度（ZCode Start Plan）',
      inputModalities: metaFor(m.id).inputModalities,
    }))
  }

  async resolveModel(provider, model) {
    const meta = metaFor(model)
    return {
      provider,
      id: model,
      name: model,
      inputModalities: meta.inputModalities,
      context: { contextWindow: meta.contextWindow },
      defaultMaxTokens: meta.defaultMaxTokens,
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /** DSH 消息词汇 → Anthropic Messages；无法精确映射的非文本块不伪造内容。
   *  role='system' 消息不进入 messages（其文本由 stream 提取进 system 块，避免重复）。 */
  toAnthropicMessages(options) {
    const out = []
    for (const msg of Array.isArray(options.messages) ? options.messages : []) {
      const role = msg && msg.role
      const content = Array.isArray(msg && msg.content) ? msg.content : []
      if (role === 'user') {
        const parts = content.filter((b) => b && b.type === 'text')
          .map((b) => ({ type: 'text', text: b.text || '' }))
        if (parts.length) out.push({ role: 'user', content: parts })
      } else if (role === 'assistant') {
        const parts = []
        for (const b of content) {
          if (!b) continue
          if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' })
          else if (b.type === 'tool-call') {
            let input = {}
            try { input = b.arguments ? JSON.parse(b.arguments) : {} } catch { input = {} }
            parts.push({ type: 'tool_use', id: b.id, name: b.name || '', input })
          }
        }
        if (parts.length) out.push({ role: 'assistant', content: parts })
      } else if (role === 'tool' || role === 'toolResult') {
        const text = content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
        const toolUseId = msg.toolCallId || msg.tool_use_id || msg.toolUseId || msg.toolResultId
        out.push({
          role: 'user',
          content: toolUseId
            ? [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]
            : [{ type: 'text', text }],
        })
      }
    }
    return out
  }

  async *stream(options = {}) {
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
      return
    }
    let auth
    try {
      auth = await this.resolveAuth()
    } catch {
      const err = new GiftRequestError('赠送额度凭据不可用（需要 ZCode 登录会话）')
      err.code = 'MISSING_CREDENTIAL'
      throw err
    }
    const token = auth && typeof auth.token === 'string' ? auth.token : ''
    let device = auth && typeof auth.deviceMid === 'string' ? auth.deviceMid.trim() : ''
    if (!device) {
      try { device = String((await this.readDevice()) || '').trim() } catch { device = '' }
    }
    // 已验证端点必须同时具备登录会话与设备标识；缺一项直接失败，绝不发出请求。
    if (!/^[\x21-\x7e]+$/.test(token) || !/^[\x20-\x7e]+$/.test(device)) {
      const err = new Error('赠送额度请求需要 ZCode 登录会话与设备标识（deviceMid）：请先登录 ZCode 桌面端，或由宿主注入 readDevice。')
      err.code = 'MISSING_CREDENTIAL'
      throw err
    }
    // 每次调用独立生成会话/查询/请求/追踪 ID，不复用官方客户端或前一次请求的 ID。
    const sessionId = randomUUID()
    const queryId = randomUUID()
    const requestId = randomUUID()
    const traceId = randomUUID()
    // DSH 真实会话把系统提示词放在 role='system' 消息里（GenerateOptions.system 通常为空）：
    // 调用方 system 顺序为 options.system 在前、会话历史 system 在后，空行拼接后追加到验证上下文第三块。
    const callerSystem = [systemText(options.system), historySystemText(options.messages)]
      .filter((part) => part.trim())
      .join('\n\n')
    // 请求上限跟随当前模型的官方配置：glm-5.3-flash/5.2 → 128000，glm-5-turbo → 64000，未知 → 16384。
    const body = {
      model: canonicalModelId(options.model),
      max_tokens: clampMaxTokens(options.maxTokens, metaFor(options.model).defaultMaxTokens),
      stream: true,
      thinking: { type: 'enabled' },
      output_config: { effort: EFFORT_LEVELS.includes(options.reasoningEffort) ? options.reasoningEffort : 'low' },
      system: composeStartPlanSystem(callerSystem),
      messages: this.toAnthropicMessages(options),
      metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: sessionId }) },
    }
    // 不发送 temperature/top_p：已验证请求未使用，thinking 开启时部分取值会 400。
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }
    if (Array.isArray(options.stop) && options.stop.length) body.stop_sequences = options.stop

    const ctl = new AbortController()
    const onAbort = () => {
      ctl.abort()
      // 注入的 fetch/响应流也可能不响应 signal，主动取消正在等待的 read。
      if (reader) void cancelReader()
    }
    let res
    let reader
    let readerCancellation
    const cancelReader = () => readerCancellation ??= Promise.resolve().then(() => reader.cancel()).catch(() => {})
    const protocolError = (message) => {
      const error = new GiftRequestError('赠送额度 Anthropic SSE 协议错误：' + message)
      error.code = 'UNKNOWN'
      return error
    }
    try {
      if (options.signal) {
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }
      ctl.signal.throwIfAborted()
      res = await fetch(START_PLAN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: startPlanHeaders({ token, device, sessionId, queryId, requestId, traceId }),
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!res.ok || !res.body) {
        const text = await readResponseText(res, { signal: ctl.signal, maxBytes: 65536 })
        const accessError = startPlanAccessError(res.status, text, [token, device])
        if (accessError) throw accessError
        const err = new GiftRequestError('赠送额度端点 HTTP ' + res.status)
        err.code = res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'RATE_LIMIT' : 'UNKNOWN'
        if (res.status === 402) err.code = 'QUOTA'
        throw err
      }

      // Start Plan 可能用 HTTP 200 返回业务错误（如 code=1005），不能当成空 SSE 静默结束。
      const contentType = String(res.headers.get('content-type') || '')
      if (!/text\/event-stream/i.test(contentType)) {
        const text = await readResponseText(res, { signal: ctl.signal, maxBytes: 65536 })
        const accessError = startPlanAccessError(res.status, text, [token, device])
        if (accessError) throw accessError
        let envelope = null
        try { envelope = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
        if (envelope && typeof envelope.code === 'number' && envelope.code !== 0) {
          const err = new GiftRequestError('Start Plan 请求失败（code ' + envelope.code + '）')
          err.bizCode = envelope.code
          err.code = envelope.code === 1005 ? 'QUOTA' : envelope.code === 1006 ? 'AUTH' : 'UNKNOWN'
          throw err
        }
        throw new GiftRequestError('赠送额度端点未返回 Anthropic SSE')
      }

      // ---------------------------------------------------------------- SSE 解析与用量
      const blocks = new Map() // index -> { kind, text, id, name, arguments }
      let openBlockChars = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let sawUsage = false
      let stopReason = null
      let started = false
      let stopped = false
      const closeBlock = (index) => {
        const block = blocks.get(index)
        if (!block) return null
        blocks.delete(index)
        openBlockChars -= block.text.length + block.arguments.length
        if (block.kind === 'text') return { type: 'block-end', index, block: { type: 'text', text: block.text } }
        if (block.kind === 'reasoning') return { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
        if (block.kind === 'tool-call') {
          return { type: 'block-end', index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } }
        }
        return null
      }

      function* parseEvent(payload) {
        if (!payload || payload === '[DONE]') return
        let ev
        try { ev = JSON.parse(payload) } catch { throw protocolError('无效 JSON 事件') }
        if (!ev || Array.isArray(ev) || typeof ev !== 'object' || typeof ev.type !== 'string') {
          throw protocolError('无效 event 事件')
        }
        const type = ev.type
        if (type === 'message_start') {
          if (started) throw protocolError('重复 message_start')
          const message = ev.message
          if (!message || typeof message.id !== 'string' || !message.id || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length) {
            throw protocolError('无效 message_start')
          }
          started = true
          const u = ev.message && ev.message.usage
          if (u) {
            sawUsage = true
            const count = (n) => Number.isFinite(n) && n >= 0 ? n : 0
            inputTokens = count(u.input_tokens)
            outputTokens = count(u.output_tokens)
            cacheReadTokens = count(u.cache_read_input_tokens)
            cacheWriteTokens = count(u.cache_creation_input_tokens)
          }
          return
        }
        if (['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type) && !started) {
          throw protocolError('缺少有效 message_start')
        }
        if (type === 'content_block_start') {
          const index = ev.index
          if (!Number.isInteger(index) || index < 0) throw protocolError('无效 content block index')
          if (blocks.has(index)) throw protocolError('重复 content_block_start')
          if (blocks.size >= 1024) throw protocolError('打开的 content block 过多')
          const raw = ev.content_block
          if (!raw || typeof raw.type !== 'string') throw protocolError('无效 content_block_start')
          const kind = raw.type === 'text' ? 'text' : raw.type === 'thinking' ? 'reasoning' : raw.type === 'tool_use' ? 'tool-call' : 'other'
          const block = {
            kind,
            text: raw.text || raw.thinking || '',
            id: raw.id || ('call-' + index),
            name: raw.name || '',
            arguments: raw.input && typeof raw.input === 'object' && Object.keys(raw.input).length ? JSON.stringify(raw.input) : '',
          }
          if (typeof block.text !== 'string') throw protocolError('无效 content block 文本')
          openBlockChars += block.text.length + block.arguments.length
          if (openBlockChars > MAX_BLOCK_CHARS) throw protocolError('content block 超过大小限制')
          blocks.set(index, block)
          if (kind !== 'other') yield { type: 'block-start', index, blockType: kind }
          if (kind === 'tool-call') {
            yield {
              type: 'tool-call-delta', index, id: block.id, name: block.name || undefined,
              argumentsDelta: block.arguments,
            }
          }
          return
        }
        if (type === 'content_block_delta') {
          const index = Number(ev.index)
          const block = blocks.get(index)
          const delta = ev.delta || {}
          if (!block) throw protocolError('content_block_delta 没有打开的 block')
          const field = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'input_json_delta' ? 'partial_json' : null
          if (field) {
            const expected = field === 'text' ? 'text' : field === 'thinking' ? 'reasoning' : 'tool-call'
            if (block.kind !== expected || typeof delta[field] !== 'string') throw protocolError('无效 content block delta')
            openBlockChars += delta[field].length
            if (openBlockChars > MAX_BLOCK_CHARS) throw protocolError('content block 超过大小限制')
          }
          if (delta.type === 'text_delta') {
            block.text += delta.text || ''
            yield { type: 'text-delta', index, text: delta.text || '' }
          } else if (delta.type === 'thinking_delta') {
            block.text += delta.thinking || ''
            yield { type: 'reasoning-delta', index, text: delta.thinking || '' }
          } else if (delta.type === 'input_json_delta') {
            block.arguments += delta.partial_json || ''
            yield { type: 'tool-call-delta', index, id: block.id, name: block.name || undefined, argumentsDelta: delta.partial_json || '' }
          }
          return
        }
        if (type === 'content_block_stop') {
          if (!blocks.has(ev.index)) throw protocolError('content_block_stop 没有打开的 block')
          const closed = closeBlock(ev.index)
          if (closed) yield closed
          return
        }
        if (type === 'message_delta') {
          if (ev.delta?.stop_reason != null) {
            if (!['end_turn', 'stop_sequence', 'max_tokens', 'tool_use'].includes(ev.delta.stop_reason)) {
              throw protocolError('未知 stop_reason')
            }
            if (stopReason && stopReason !== ev.delta.stop_reason) throw protocolError('冲突 stop_reason')
            stopReason = ev.delta.stop_reason
          }
          const u = ev.usage
          if (u) {
            sawUsage = true
            if (Number.isFinite(u.input_tokens) && u.input_tokens >= 0) inputTokens = u.input_tokens
            if (Number.isFinite(u.output_tokens) && u.output_tokens >= 0) outputTokens = u.output_tokens
            if (Number.isFinite(u.cache_read_input_tokens) && u.cache_read_input_tokens >= 0) cacheReadTokens = u.cache_read_input_tokens
            if (Number.isFinite(u.cache_creation_input_tokens) && u.cache_creation_input_tokens >= 0) cacheWriteTokens = u.cache_creation_input_tokens
          }
          return
        }
        if (type === 'message_stop') {
          if (blocks.size) throw protocolError('message_stop 前仍有未关闭的 content block')
          if (!stopReason) throw protocolError('缺少 stop_reason')
          stopped = true
          return
        }
        if (type === 'error') {
          const raw = ev.error || {}
          const err = new GiftRequestError('Start Plan 上游错误')
          const kind = String(raw.type || '')
          err.code = /authentication|permission/i.test(kind) ? 'AUTH'
            : /overloaded|rate/i.test(kind) ? 'RATE_LIMIT'
            : /too_large|context/i.test(kind) ? 'CONTEXT_WINDOW_EXCEEDED'
            : 'UNKNOWN'
          throw err
        }
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let data = []
      let eventChars = 0
      while (!stopped) {
        ctl.signal.throwIfAborted()
        const { done, value } = await reader.read()
        ctl.signal.throwIfAborted()
        buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
        // EOF 也必须检查残余 data，不能吞掉末尾截断的 JSON。
        if (done && buf) buf += '\n'
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          if (nl > MAX_SSE_EVENT_CHARS) throw protocolError('SSE 行超过大小限制')
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line === '') {
            if (data.length) yield* parseEvent(data.join('\n'))
            data = []
            eventChars = 0
            if (stopped) break // message_stop 是协议终点，不等待连接 EOF。
          } else if (line.startsWith('data:')) {
            eventChars += line.length
            if (eventChars > MAX_SSE_EVENT_CHARS) throw protocolError('SSE 事件超过大小限制')
            data.push(line.slice(5).replace(/^ /, ''))
          }
        }
        if (stopped) break
        if (buf.length > MAX_SSE_EVENT_CHARS) throw protocolError('SSE 行超过大小限制')
        if (done) {
          if (data.length) yield* parseEvent(data.join('\n'))
          break
        }
      }
      if (!started) throw protocolError('缺少有效 message_start')
      if (!stopped) throw protocolError('流被截断：缺少 message_stop')
      if (sawUsage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
          },
        }
      }
      const reason = stopReason === 'max_tokens' ? { kind: 'max-tokens' }
        : stopReason === 'tool_use' ? { kind: 'tool-calls' }
        : { kind: 'stop' }
      yield { type: 'finish', reason }
    } catch (e) {
      if (ctl.signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        return
      }
      if (e instanceof GiftRequestError) throw e
      throw new GiftRequestError('赠送额度请求或响应读取失败')
    } finally {
      options.signal && options.signal.removeEventListener('abort', onAbort)
      // 正常完成、响应检查失败、解析失败和消费者提前退出都释放网络资源。
      // 清理失败不能覆盖上游/协议错误，也不能阻止 releaseLock。
      if (reader) {
        await cancelReader()
        try { reader.releaseLock() } catch { /* best effort */ }
      } else if (res?.body) {
        try { await res.body.cancel() } catch { /* body 可能已经由 text() 消费 */ }
      }
    }
  }
}

// ---------------------------------------------------------------- 响应体读取
// 响应体也属于请求期限；限制错误页/JSON 的大小，避免无限流占满内存。
export async function readResponseText(response, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('响应体超过大小限制')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try { await reader.cancel() } catch { /* 保留读取错误 */ }
    try { reader.releaseLock() } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------- 到期回退
const modelKey = (value) => typeof value === 'string' ? value.trim().toLowerCase() : ''
const sameSelection = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort

/** 所有同名 token 桶都明确到期才回退；耗尽、未知截止和查询失败都不是到期证据。 */
function expiredRoute(state, model, now) {
  if (!state || typeof state.parentRoute !== 'string' || !state.parentRoute.trim() || state.parentRoute === GIFT_PROVIDER) return null
  const key = modelKey(model)
  if (!key || !Array.isArray(state.buckets)) return null
  const buckets = state.buckets.filter((bucket) => bucket && modelKey(bucket.model) === key && (!bucket.unitType || bucket.unitType === 'token'))
  return buckets.length && buckets.every((bucket) => Number.isFinite(bucket.expiresAt) && bucket.expiresAt > 0 && bucket.expiresAt <= now)
    ? state.parentRoute : null
}

/**
 * 为已挂载的普通 Web 会话安装赠额到期回退。
 * getState() -> { parentRoute, buckets } | null：Host 保留可信截止证据，鉴权/关联配置失效时返回 null。
 * 快照或截止计时器更新后 await sweep()；dispose() 卸载所有监听并使在途检查失效。
 * 仅调用目录/配置解析与会话选择 API，不发生成请求、不修改全局默认或历史消息。
 */
export function createGiftFallback(ctx, { getState, now = Date.now }) {
  const attached = new Map()
  const selectionVersions = new WeakMap()
  const pending = new WeakMap()
  let disposed = false
  const selectionService = () => ctx.sessionController?.agents
  const live = (agent) => !disposed && ctx.agents?.get(agent.id) === agent
  const ordinary = (agent) => {
    if (agent?.session?.header?.cwd === undefined || agent.session.header.origin === 'subagent') return false
    const parent = agent.session.header.parentSession && ctx.agents?.get(agent.session.header.parentSession)
    return !parent || !ctx.agents.isOwnedBy?.(agent.id, parent)
  }

  async function check(agent) {
    const owner = selectionService()
    if (!live(agent) || !ordinary(agent) || typeof owner?.selectionFor !== 'function'
      || typeof owner?.serializeImageAdmission !== 'function' || typeof owner?.selectForNextRequest !== 'function'
      || typeof ctx.llm?.listModels !== 'function' || typeof ctx.llm?.resolveCallConfig !== 'function') return false
    const selected = { ...owner.selectionFor(agent).current }
    if (selected.provider !== GIFT_PROVIDER) return false
    const route = expiredRoute(getState(), selected.model, now())
    if (!route) return false
    const version = selectionVersions.get(agent.session)
    const stillCurrent = () => live(agent) && selectionService() === owner
      && selectionVersions.get(agent.session) === version
      && sameSelection(owner.selectionFor(agent).current, selected)
      && expiredRoute(getState(), selected.model, now()) === route
    return owner.serializeImageAdmission(agent, async () => {
      if (!stillCurrent()) return false
      const models = await ctx.llm.listModels(route)
      if (!stillCurrent() || !Array.isArray(models)) return false
      const matches = models.filter((model) => model && model.provider === route && modelKey(model.id) === modelKey(selected.model))
      const target = matches.find((model) => model.id === selected.model) ?? (matches.length === 1 ? matches[0] : undefined)
      if (!target) return false
      // 新 provider 自行决定 effort 默认值，不能把赠送端特有 effort 强塞给关联适配器。
      const resolved = await ctx.llm.resolveCallConfig({ provider: route, model: target.id })
      if (!stillCurrent() || resolved?.provider !== route || resolved.model !== target.id) return false
      owner.selectForNextRequest(agent, {
        provider: route,
        model: target.id,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      })
      return true
    })
  }

  function checkOnce(agent) {
    if (pending.has(agent)) return pending.get(agent)
    // 目录服务缺失/暂不可用时保留原选择；下次快照或组装会重试。
    const operation = check(agent).catch(() => false).finally(() => pending.delete(agent))
    pending.set(agent, operation)
    return operation
  }

  function attach(agent) {
    if (disposed || attached.has(agent) || !ordinary(agent) || typeof agent.ctx?.on !== 'function') return
    // 必须先于宿主 installModelSelection 的快照；只改下一次组装，已发出的请求不受影响。
    const off = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await checkOnce(agent)
      return next()
    }, { prepend: true })
    attached.set(agent, off)
  }

  const offCreated = ctx.on('agent/created', ({ agent }) => attach(agent))
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    attached.get(agent)?.()
    attached.delete(agent)
  })
  const offSelection = ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') selectionVersions.set(session, (selectionVersions.get(session) ?? 0) + 1)
  })
  for (const agent of ctx.agents?.list?.() ?? []) attach(agent)

  return {
    async sweep() {
      if (disposed) return 0
      const agents = ctx.agents?.list?.() ?? []
      for (const agent of agents) attach(agent)
      const results = await Promise.all(agents.map(checkOnce))
      return results.filter(Boolean).length
    },
    dispose() {
      if (disposed) return
      disposed = true
      offCreated?.()
      offDisposed?.()
      offSelection?.()
      for (const off of attached.values()) off?.()
      attached.clear()
    },
  }
}
