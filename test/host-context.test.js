import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
let cordisEntry
try { cordisEntry = require.resolve('@deepseek-ai/cordis') } catch {}
if (!cordisEntry && process.env.DSH_LLM_ENTRY) {
  try { cordisEntry = createRequire(pathToFileURL(path.resolve(process.env.DSH_LLM_ENTRY))).resolve('@deepseek-ai/cordis') } catch {}
}
if (!cordisEntry && process.resourcesPath) {
  try { cordisEntry = require.resolve('@deepseek-ai/cordis', { paths: [path.join(process.resourcesPath, 'app.asar', 'dsh')] }) } catch {}
}
const { Context } = cordisEntry ? await import(pathToFileURL(cordisEntry).href) : {}
const hostTest = (name, fn) => test(name, { skip: !Context && '需要真实 Cordis；可用宿主 Electron 或 DSH_LLM_ENTRY 定位' }, fn)

async function harness(t, optionalServices) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dmu-host-context-'))
  const profile = path.join(dir, 'profile')
  const env = {
    DSH_HOME: dir, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined,
    DMU_ZCODE_CRED_FILE: path.join(dir, 'missing-credentials.json'),
    DMU_ZCODE_TELEMETRY_FILE: path.join(dir, 'missing-telemetry.json'),
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const root = new Context()
  t.after(async () => {
    await root.fiber.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.equal(path.dirname(dir), path.resolve(tmpdir()))
    assert.ok(path.basename(dir).startsWith('dmu-host-context-'))
    await rm(dir, { recursive: true })
  })
  await mkdir(profile)
  await writeFile(path.join(profile, 'cordis.yml'), [
    'plugins:', '  pi-ai:', '    providers:', '      custom-deepseek:',
    '        baseURL: https://api.deepseek.com', '        apiKeyEnv: FIXTURE_ONLY_KEY',
  ].join('\n'))
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://api.deepseek.com/user/balance', '只允许离线余额替身')
    return new Response(JSON.stringify({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '10', granted_balance: '0', topped_up_balance: '10' },
    ] }))
  })
  const plugin = await import('../lib/index.mjs')
  const { invalidateProfileCache } = await import('../lib/profile.mjs')
  invalidateProfileCache()
  t.after(invalidateProfileCache)
  let handler, promptHook
  let listCalls = 0
  let selectionCalls = 0
  const agent = {
    id: 'fixture-agent', session: { header: { cwd: dir } },
    ctx: { on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      promptHook = callback
      return () => { promptHook = undefined }
    } },
  }
  // 必须由兄弟插件提供服务：root.provide 或 extend 元数据会绕过真实 inject 检查。
  await root.plugin({ name: 'host-context-fixture-services', apply(ctx) {
    ctx.provide('llm', {
      adapters: new Map(), listProviders: () => [{ id: 'custom-deepseek', name: 'Fixture' }],
      listModels: async () => [], resolveCallConfig: async value => value,
    })
    ctx.provide('credentials', { resolve: async ref => ref === 'FIXTURE_ONLY_KEY' ? { value: 'fixture-key' } : null })
    ctx.provide('connection', { admit: () => ({}) })
    ctx.provide('webServer', { register(route) { handler = route.handler; return () => {} } })
    ctx.provide('pluginManager', { profile: { dir: optionalServices ? path.join(dir, 'wrong-profile') : profile } })
  } })
  let optionalFiber
  async function mountOptional() {
    optionalFiber = root.plugin({ name: 'host-context-optional-services', apply(ctx) {
      ctx.provide('profileContext', { dir: profile })
      ctx.provide('agents', { list() { listCalls++; return [agent] }, get: id => id === agent.id ? agent : null })
      ctx.provide('sessionController', { agents: {
        selectionFor() { selectionCalls++; return { current: { provider: 'custom-deepseek', model: 'fixture' } } },
        serializeImageAdmission: (_agent, fn) => fn(), selectForNextRequest() {},
      } })
    } })
    await optionalFiber
    await new Promise(resolve => setImmediate(resolve))
  }
  if (optionalServices) await mountOptional()
  await root.plugin(plugin, { sessionResolver: async () => null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof handler, 'function')
  async function snapshot() {
    const request = new EventEmitter()
    request.method = 'POST'
    const response = new Promise(resolve => {
      void handler(request, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
    })
    request.emit('data', Buffer.from(JSON.stringify({ endpoint: 'snapshot' })))
    request.emit('end')
    const result = await response
    const scopeErrors = []
    root.registry.forEach(runtime => { for (const fiber of runtime.fibers) {
      if (fiber._error) scopeErrors.push(fiber._error.message)
    } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.providers.map(provider => provider.route), ['custom-deepseek'], scopeErrors.join('; '))
    assert.equal(result.value.providers[0].status, 'ok')
    assert.deepEqual(scopeErrors, [], '可选服务不能使额度作用域加载失败')
  }
  await snapshot()
  return {
    snapshot, mountOptional,
    async removeOptional() {
      await optionalFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(promptHook, undefined, '可选服务卸载后移除回退钩子')
    },
    async checkFallback() {
      assert.ok(listCalls > 0, '到期回退可读取兄弟 agents 服务')
      assert.equal(typeof promptHook, 'function', '已挂载会话安装了回退钩子')
      let continued = false
      await promptHook({}, {}, async () => { continued = true })
      assert.ok(selectionCalls > 0, '回退检查可读取兄弟 sessionController 服务')
      assert.equal(continued, true)
    },
  }
}

hostTest('真实 Cordis：缺少可选 agents/sessionController 时仍返回自定义 provider 卡片', async t => {
  await harness(t, false)
})

hostTest('真实 Cordis：兄弟 profileContext/agents/sessionController 服务可用于卡片与回退', async t => {
  const host = await harness(t, true)
  await host.checkFallback()
})

hostTest('真实 Cordis：可选服务晚加载和卸载不影响已运行的额度卡片', async t => {
  const host = await harness(t, false)
  await host.mountOptional()
  await host.checkFallback()
  await host.snapshot()
  await host.removeOptional()
  await host.snapshot()
})
