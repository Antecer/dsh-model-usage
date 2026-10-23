import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------- 被测对象
// 插件客户端必须单文件交付（ModuleLoader 按包名注册，无相对模块解析），
// trackCurrentRoute 的唯一实现内联在 lib/client.js 中。
// 这里直接抽取内联副本执行，保证测试跑的就是发布产物里的代码。

function loadInlineTracker() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function trackCurrentRoute')
  const end = src.indexOf('共用组件', start)
  assert.ok(start > 0 && end > start, 'client.js 应内联 trackCurrentRoute（不能 require 相对模块）')
  assert.ok(!src.includes("require('./"), 'client.js 不允许 require 相对模块')
  return new Function(src.slice(start, end) + '\nreturn trackCurrentRoute')()
}

const trackCurrentRoute = loadInlineTracker()

// ---------------------------------------------------------------- 测试夹具
// 形态对齐真实 DSH 客户端契约（dsh-cordis-client-runner / dsh-client-ui-session）：
// - sessions.list: ObservableSnapshot<{ byId: Record<id, { retainedBy?: { mainView?: number } }> }>
// - sessions.binding(id).session.projections.faceOf('modelSelection'): ObservableSnapshot<{ next, lastUsed }>
// - ctx.uiSession.current: ObservableSnapshot<{ key?: sessionId }>（主视图绑定，可选）

function makeFace(snapshot) {
  const subs = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    _set: (s) => { snapshot = s; for (const cb of subs) cb() },
  }
}

function makeBinding(provider) {
  const snapshot = provider == null
    ? { next: null, lastUsed: null }
    : { next: { provider }, lastUsed: null }
  const face = makeFace(snapshot)
  return {
    session: {
      projections: {
        faceOf: (type) => {
          if (type === 'modelSelection') return face
          throw new Error('unexpected projection ' + type)
        },
      },
    },
  }
}

/** byId 行带 retainedBy；_setMainView 模拟点击左侧列表切换主视图会话。 */
function makeSessions(ids, bindings, mainViewId = ids[0]) {
  const byId = {}
  for (const id of ids) byId[id] = { retainedBy: id === mainViewId ? { mainView: 1 } : {} }
  const listSubs = new Set()
  return {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe: (cb) => { listSubs.add(cb); return () => listSubs.delete(cb) },
    },
    binding: (id) => (bindings || {})[id],
    _setMainView(id) {
      for (const row of Object.values(byId)) row.retainedBy = {}
      if (id && byId[id]) byId[id].retainedBy = { mainView: 1 }
      for (const cb of [...listSubs]) cb()
    },
  }
}

function makeUiSession(initialKey) {
  let key = initialKey
  const subs = new Set()
  return {
    current: {
      getSnapshot: () => ({ key }),
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
      _set: (k) => { key = k; for (const cb of [...subs]) cb() },
    },
  }
}

function makeApi(route, delay = 0) {
  return {
    current: () => new Promise((resolve) => setTimeout(() => resolve(route == null ? null : { route }), delay)),
  }
}

// 浏览器侧模型目录（dsh-client-ui-model-selection 的 modelDirectories 服务）：
// store 快照形如 { value: { default: { provider } }, status }，随加载/默认值变更通知订阅者。
function makeCatalogStore(provider) {
  let value = provider == null ? null : { default: { provider } }
  let status = provider == null ? 'loading' : 'ready'
  const subs = new Set()
  return {
    getSnapshot: () => ({ value, status }),
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    _ready(nextProvider) {
      value = nextProvider == null ? null : { default: { provider: nextProvider } }
      status = nextProvider == null ? 'loading' : 'ready'
      for (const cb of [...subs]) cb()
    },
    get subscriberCount() { return subs.size },
  }
}

function makeModelDirectories(store) {
  return { catalog: { store } }
}

/** 只暴露给定服务的 ctx.get（cordis 可选取值，不要求 inject 声明）。 */
function makeServiceCtx(sessions, services) {
  const ctx = { sessions, get: (name) => (services || {})[name] }
  return ctx
}

const immediate = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------- 用例

test('点击左侧列表切换对话（retainedBy.mainView 转移），卡片立即跟随', async () => {
  const sessions = makeSessions(['a', 'b'], { a: makeBinding('X'), b: makeBinding('Y') }, 'a')
  const routes = []
  const dispose = trackCurrentRoute({ sessions }, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['X'])

  sessions._setMainView('b')
  await immediate()
  assert.deepEqual(routes, ['X', 'Y'])
  dispose()
})

test('uiSession.current 优先于列表扫描，且其变化立即生效', async () => {
  const sessions = makeSessions(['a', 'b'], { a: makeBinding('X'), b: makeBinding('Y') }, 'a')
  const uiSession = makeUiSession('b') // 主视图其实是 b（列表行的 retainedBy 可能滞后）
  // cordis 不允许访问未 inject 的服务属性，插件通过 ctx.get('uiSession') 读取
  const ctx = { sessions, get: (name) => (name === 'uiSession' ? uiSession : undefined) }
  const routes = []
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['Y'])

  uiSession.current._set('a')
  await immediate()
  assert.deepEqual(routes, ['Y', 'X'])
  dispose()
})

test('无 retainedBy/uiSession 时回退到会话列表第一项', async () => {
  const sessions = makeSessions(['a', 'b'], { a: makeBinding('Z'), b: makeBinding('W') }, null)
  const routes = []
  const dispose = trackCurrentRoute({ sessions }, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['Z'])
  dispose()
})

test('切换到无 modelSelection 的新会话时保持原选择', async () => {
  const sessions = makeSessions(['a', 'b'], { a: makeBinding('X'), b: makeBinding(null) }, 'a')
  const routes = []
  const dispose = trackCurrentRoute({ sessions }, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['X'])

  sessions._setMainView('b')
  await immediate()
  assert.deepEqual(routes, ['X'])
  dispose()
})

test('同一会话内切换模型（face 更新）也立即跟随', async () => {
  const binding = makeBinding('X')
  const sessions = makeSessions(['a'], { a: binding }, 'a')
  const routes = []
  const dispose = trackCurrentRoute({ sessions }, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['X'])

  const face = binding.session.projections.faceOf('modelSelection')
  face._set({ next: { provider: 'Y' }, lastUsed: { provider: 'X' } })
  await immediate()
  assert.deepEqual(routes, ['X', 'Y'])
  dispose()
})

test('异步旧的 Host current 响应不覆盖会话选择', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding('X') }, 'a')
  const routes = []
  let resolveCurrent
  const api = { current: () => new Promise((resolve) => { resolveCurrent = resolve }) }
  const dispose = trackCurrentRoute({ sessions }, api, (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['X'])

  resolveCurrent({ route: 'Y' })
  await immediate()
  assert.deepEqual(routes, ['X'])
  dispose()
})

test('dispose 后停止监听，后续变化不再回调', async () => {
  const sessions = makeSessions(['a', 'b'], { a: makeBinding('X'), b: makeBinding('Y') }, 'a')
  const routes = []
  const dispose = trackCurrentRoute({ sessions }, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['X'])

  dispose()
  sessions._setMainView('b')
  await immediate()
  assert.deepEqual(routes, ['X'])
})

test('新建对话无选择时立即回退到 agentDefaultModel 默认供应商', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const routes = []
  const ctx = {
    sessions,
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'D' }) } : undefined),
  }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['D'], '新会话应立即跟随默认供应商，而不是等点模型/发消息')

  const face = sessions.binding('a').session.projections.faceOf('modelSelection')
  face._set({ next: { provider: 'X' }, lastUsed: null })
  await immediate()
  assert.deepEqual(routes, ['D', 'X'], '用户选择后覆盖默认值')
  dispose()
})

test('新建对话无选择时立即跟随浏览器侧模型目录的默认供应商', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const catalog = makeCatalogStore('D')
  const routes = []
  const ctx = makeServiceCtx(sessions, { modelDirectories: makeModelDirectories(catalog) })
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['D'], '新会话应立即跟随目录 default，而不是等点模型/发消息')

  const face = sessions.binding('a').session.projections.faceOf('modelSelection')
  face._set({ next: { provider: 'X' }, lastUsed: null })
  await immediate()
  assert.deepEqual(routes, ['D', 'X'], '用户选择后覆盖默认值')
  dispose()
})

test('模型目录尚未加载完成：加载完成（default 就绪）后立即跟随', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const catalog = makeCatalogStore(null)
  const routes = []
  const ctx = makeServiceCtx(sessions, { modelDirectories: makeModelDirectories(catalog) })
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, [], '目录未就绪时不应误报')
  catalog._ready('D')
  await immediate()
  assert.deepEqual(routes, ['D'], '目录就绪后应立即跟随默认供应商')
  dispose()
})

test('默认模型变化时空白新会话自动跟随新默认值', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const catalog = makeCatalogStore('D')
  const routes = []
  const ctx = makeServiceCtx(sessions, { modelDirectories: makeModelDirectories(catalog) })
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['D'])
  catalog._ready('K')
  await immediate()
  assert.deepEqual(routes, ['D', 'K'], '宿主默认模型变更后，未选择的会话应跟随新默认')
  dispose()
})

test('新建对话首页尚无会话 id（无绑定）时也跟随默认供应商', async () => {
  const sessions = makeSessions([], {}, null)
  const catalog = makeCatalogStore('D')
  const routes = []
  const ctx = makeServiceCtx(sessions, { modelDirectories: makeModelDirectories(catalog) })
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['D'], '没有当前会话时仍显示 DSH 默认模型')
  dispose()
})

test('会话已有显式选择时不被模型目录 default 覆盖', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding('Y') }, 'a')
  const catalog = makeCatalogStore('D')
  const routes = []
  const ctx = makeServiceCtx(sessions, { modelDirectories: makeModelDirectories(catalog) })
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['Y'], '已有选择优先于目录默认值')
  dispose()
})

test('模型目录服务晚于插件就绪：服务出现后自动跟随默认供应商', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const routes = []
  const listeners = new Set()
  let catalog = null
  const ctx = {
    sessions,
    get: (name) => (name === 'modelDirectories' ? catalog : undefined),
    on: (event, cb) => { if (event === 'internal/service') listeners.add(cb); return () => listeners.delete(cb) },
  }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, [], '服务未就绪时不切换')
  catalog = makeModelDirectories(makeCatalogStore('D'))
  for (const cb of [...listeners]) cb('modelDirectories', catalog)
  await immediate()
  assert.deepEqual(routes, ['D'], 'modelDirectories 就绪后应立即跟随其默认供应商')
  dispose()
})

test('会话已有选择时不使用 agentDefaultModel 默认值', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding('Y') }, 'a')
  const routes = []
  const ctx = {
    sessions,
    get: () => ({ currentSelection: () => ({ provider: 'D' }) }),
  }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['Y'], '已有选择优先于默认值')
  dispose()
})

test('agentDefaultModel 不可用（cordis 未提供该服务）时新会话不切换', async () => {
  const sessions = makeSessions(['a'], { a: makeBinding(null) }, 'a')
  const routes = []
  const ctx = { sessions, get: () => { throw new Error('service not found') } }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, [], '服务缺失时静默不切换（保持现状）')
  dispose()
})

test('新会话投影未就绪时自动重试，就绪后立即跟随', async () => {
  let calls = 0
  const face = makeFace({ next: null, lastUsed: null })
  const binding = {
    session: {
      projections: { faceOf: () => (++calls > 2 ? face : null) },
    },
  }
  const sessions = makeSessions(['a'], { a: binding }, 'a')
  const routes = []
  const ctx = {
    sessions,
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'D' }) } : undefined),
  }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, [], '未就绪期间不应有误报')
  await new Promise((r) => setTimeout(r, 700)) // 200ms + 400ms 两次重试窗口
  assert.deepEqual(routes, ['D'], '投影就绪后回退默认供应商')
  dispose()
})

test('新会话无选择但有历史请求头时跟随 requestHeader 供应商', async () => {
  const face = makeFace({ next: null, lastUsed: null })
  const binding = {
    session: {
      projections: { faceOf: () => face },
      requestHeader: () => ({ config: { provider: 'H', model: 'm1' } }),
    },
  }
  const sessions = makeSessions(['a'], { a: binding }, 'a')
  const routes = []
  const ctx = {
    sessions,
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'D' }) } : undefined),
  }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  assert.deepEqual(routes, ['H'], 'logged 请求头优先于 agentDefaultModel')
  dispose()
})

test('重试期间切换会话：旧重试不再生效（代际保护）', async () => {
  let aCalls = 0
  const aBinding = { session: { projections: { faceOf: () => (++aCalls > 5 ? makeFace({ next: null, lastUsed: null }) : null) } } }
  const bBinding = makeBinding('B')
  const sessions = makeSessions(['a', 'b'], { a: aBinding, b: bBinding }, 'a')
  const routes = []
  const ctx = { sessions, get: () => undefined }
  const dispose = trackCurrentRoute(ctx, makeApi(null), (r) => routes.push(r))
  await immediate()
  sessions._setMainView('b') // 立即切到 b：a 的重试应被代际作废
  await new Promise((r) => setTimeout(r, 700))
  assert.deepEqual(routes, ['B'], '只应有 b 的选择，a 的迟来就绪不得插播')
  dispose()
})
