import test from 'node:test'
import assert from 'node:assert/strict'
import { createGiftFallback } from '../lib/zcode/gift-adapter.mjs'

const NOW = 10000
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const events = new Map()
  const agents = new Map()
  const selections = new Map()
  const chains = new WeakMap()
  const calls = { list: [], resolve: [], selected: [], defaults: 0, cancelled: 0 }
  const on = (name, listener) => {
    const set = events.get(name) ?? new Set()
    events.set(name, set)
    set.add(listener)
    return () => set.delete(listener)
  }
  const emit = (name, ...args) => { for (const listener of events.get(name) ?? []) listener(...args) }
  let state = { parentRoute: 'glm-paid', buckets: [{ model: 'GLM-5.2', unitType: 'token', remaining: 12, expiresAt: NOW }] }
  const ctx = {
    on,
    agents: { list: () => [...agents.values()], get: (id) => agents.get(id), isOwnedBy: (id, parent) => agents.get(id)?.parent === parent },
    agentDefaultModel: { saveSelection() { calls.defaults++ } },
    llm: {
      async listModels(route) { calls.list.push(route); return [{ provider: route, id: 'glm-5.2' }] },
      async resolveCallConfig(config) { calls.resolve.push(config); return { ...config, reasoningEffort: 'medium' } },
    },
    sessionController: { agents: {
      selectionFor: (agent) => selections.get(agent),
      serializeImageAdmission(agent, operation) {
        const result = (chains.get(agent) ?? Promise.resolve()).then(operation)
        chains.set(agent, result.catch(() => {}))
        return result
      },
      selectForNextRequest(agent, selected) {
        agent.session.events.push({ type: 'model/selection', data: selected })
        selections.get(agent).current = selected
        calls.selected.push({ id: agent.id, selected })
        emit('session/event', agent.session, { type: 'model/selection', data: selected })
      },
    } },
  }
  function add(id = 'session-1', selected = { provider: 'glm-gift', model: 'GLM-5.2', reasoningEffort: 'high' }, header = {}) {
    const hooks = []
    const selection = { current: selected }
    // 宿主先安装选择快照；helper 必须 prepend 到该监听之前。
    hooks.push(async (_assembly, _context, next) => {
      const current = selection.current
      const result = await next()
      return { ...result, selected: current }
    })
    const agent = {
      id,
      ctx: { on(name, listener, options) {
        assert.equal(name, 'system-prompt/assemble')
        if (options?.prepend) hooks.unshift(listener)
        else hooks.push(listener)
        return () => { const i = hooks.indexOf(listener); if (i >= 0) hooks.splice(i, 1) }
      } },
      session: { header: { cwd: '/workspace', ...header }, events: [{ type: 'assistant/message', data: { model: 'GLM-5.2', source: { kind: 'model' } } }] },
      cancel() { calls.cancelled++ },
      assemble() {
        const dispatch = (i) => i < hooks.length ? hooks[i]({}, {}, () => dispatch(i + 1)) : Promise.resolve({})
        return dispatch(0)
      },
      hooks,
    }
    agents.set(id, agent)
    selections.set(agent, selection)
    emit('agent/created', { agent })
    return agent
  }
  const agent = add()
  const fallback = createGiftFallback(ctx, { getState: () => state, now: () => NOW })
  return {
    ctx, agent, fallback, calls, add, selections, events, agents, emit,
    setState(next) { state = next },
    getState: () => state,
    choose(agent, selected) { ctx.sessionController.agents.selectForNextRequest(agent, selected) },
  }
}

test('明确到期回退到关联分组同名模型，不修改默认、历史或在途请求', async () => {
  const h = harness()
  const history = structuredClone(h.agent.session.events)
  assert.equal(await h.fallback.sweep(), 1)
  assert.deepEqual(h.calls.list, ['glm-paid'])
  assert.deepEqual(h.calls.resolve, [{ provider: 'glm-paid', model: 'glm-5.2' }])
  assert.deepEqual(h.calls.selected, [{ id: h.agent.id, selected: { provider: 'glm-paid', model: 'glm-5.2', reasoningEffort: 'medium' } }])
  assert.deepEqual(h.agent.session.events.slice(0, -1), history)
  assert.equal(h.calls.defaults, 0)
  assert.equal(h.calls.cancelled, 0)
  assert.equal(await h.fallback.sweep(), 0)
  h.fallback.dispose()
})

test('组装前完成回退，新挂载会话也获得监听', async () => {
  const h = harness()
  assert.equal((await h.agent.assemble()).selected.provider, 'glm-paid')
  const newer = h.add('session-2')
  assert.equal((await newer.assemble()).selected.provider, 'glm-paid')
  h.fallback.dispose()
  assert.equal(h.agent.hooks.length, 1)
  assert.equal(newer.hooks.length, 1)
  assert.equal([...h.events.values()].every((set) => set.size === 0), true)
})

test('耗尽、未知截止、未来桶、查询失败或关联缺失都不触发回退', async () => {
  for (const state of [
    null,
    { parentRoute: '', buckets: [{ model: 'GLM-5.2', expiresAt: NOW }] },
    { parentRoute: 'glm-gift', buckets: [{ model: 'GLM-5.2', expiresAt: NOW }] },
    { parentRoute: 'glm-paid', buckets: [] },
    { parentRoute: 'glm-paid', buckets: [{ model: 'GLM-5.2', remaining: 0 }] },
    { parentRoute: 'glm-paid', buckets: [{ model: 'GLM-5.2', remaining: 0, expiresAt: NOW + 1 }] },
    { parentRoute: 'glm-paid', buckets: [{ model: 'GLM-5.2', expiresAt: NOW }, { model: 'glm-5.2', expiresAt: null }] },
    { parentRoute: 'glm-paid', buckets: [{ model: 'GLM-5.2', expiresAt: NOW }, { model: 'glm-5.2', expiresAt: NOW + 1 }] },
  ]) {
    const h = harness()
    h.setState(state)
    assert.equal(await h.fallback.sweep(), 0)
    assert.equal(h.calls.list.length, 0)
    h.fallback.dispose()
  }
})

test('关联目录必须存在同名模型，不能回退其他 provider 或不同型号', async () => {
  for (const models of [[], [{ provider: 'other', id: 'GLM-5.2' }], [{ provider: 'glm-paid', id: 'GLM-5.3' }], [{ provider: 'glm-paid', id: 'glm-5.2' }, { provider: 'glm-paid', id: 'Glm-5.2' }]]) {
    const h = harness()
    h.ctx.llm.listModels = async () => models
    assert.equal(await h.fallback.sweep(), 0)
    assert.equal(h.calls.resolve.length, 0)
    h.fallback.dispose()
  }
})

test('异步查询期间用户切换、证据失效、会话卸载或helper卸载阻止过期写入', async () => {
  for (const change of ['selection', 'same-selection', 'state', 'route', 'agent', 'dispose']) {
    const h = harness()
    const started = deferred()
    const response = deferred()
    h.ctx.llm.listModels = async () => { started.resolve(); return response.promise }
    const operation = h.fallback.sweep()
    await started.promise
    if (change === 'selection') h.choose(h.agent, { provider: 'other', model: 'custom' })
    if (change === 'same-selection') h.choose(h.agent, { provider: 'glm-gift', model: 'GLM-5.2', reasoningEffort: 'high' })
    if (change === 'state') h.setState(null)
    if (change === 'route') h.setState({ ...h.getState(), parentRoute: 'new-paid' })
    if (change === 'agent') h.agents.delete(h.agent.id)
    if (change === 'dispose') h.fallback.dispose()
    response.resolve([{ provider: 'glm-paid', id: 'glm-5.2' }])
    assert.equal(await operation, 0, change)
    assert.equal(h.calls.selected.some((call) => call.selected.provider === 'glm-paid'), false, change)
    h.fallback.dispose()
  }
})

test('配置解析后再次检查选择及解析结果，错误不会篡改会话', async () => {
  for (const mode of ['selection', 'wrong-route', 'failure']) {
    const h = harness()
    h.ctx.llm.resolveCallConfig = async (config) => {
      if (mode === 'selection') h.choose(h.agent, { provider: 'other', model: 'user-choice' })
      if (mode === 'failure') throw new Error('catalog unavailable')
      return mode === 'wrong-route' ? { provider: 'other', model: config.model } : config
    }
    assert.equal(await h.fallback.sweep(), 0)
    assert.equal(h.calls.selected.some((call) => call.selected.provider === 'glm-paid'), false)
    h.fallback.dispose()
  }
})

test('并发sweep合并检查，能力缺失时安全保留当前选择', async () => {
  const h = harness()
  await Promise.all([h.fallback.sweep(), h.fallback.sweep()])
  assert.equal(h.calls.selected.length, 1)
  h.fallback.dispose()
  const unsupported = harness()
  delete unsupported.ctx.sessionController
  assert.equal(await unsupported.fallback.sweep(), 0)
  assert.equal((await unsupported.agent.assemble()).selected.provider, 'glm-gift')
  unsupported.fallback.dispose()
})

test('仅处理普通挂载会话，不给子代理安装新的选择层', async () => {
  const h = harness()
  const child = h.add('child', { provider: 'glm-gift', model: 'GLM-5.2' }, { origin: 'subagent' })
  assert.equal(child.hooks.length, 1)
  await h.fallback.sweep()
  assert.equal(h.selections.get(child).current.provider, 'glm-gift')
  const resumedFork = h.add('fork', { provider: 'glm-gift', model: 'GLM-5.2' }, { parentSession: 'not-mounted' })
  assert.equal((await resumedFork.assemble()).selected.provider, 'glm-paid')
  h.fallback.dispose()
})
