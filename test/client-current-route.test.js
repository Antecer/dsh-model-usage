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
