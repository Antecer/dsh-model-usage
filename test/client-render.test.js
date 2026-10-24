import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

// ---------------------------------------------------------------- 渲染闭环
// 用 jsdom + 真实 React 直接渲染 lib/client.js 这个发布产物（单文件 bundle），
// 模拟 __ModuleLoader__ / slots / locale / sessions / fetch 边界，
// 把「侧栏卡片 → 弹窗 → 右栏统计」整条链路渲染成真实 DOM 再断言。

const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const NOW = Date.now()
const dayKey = (offset) => {
  const d = new Date(NOW - offset * 86400000)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
const SNAP = {
  generatedAt: NOW, refreshSeconds: 60, card: { template: '' },
  providers: [
    {
      route: 'kimi1', displayName: 'Kimi 一号', status: 'ok', valid: true, fetchedAt: NOW - 65000,
      windows: [{ key: 'rolling', label: '5h', usedPct: 20, resetAt: NOW + 3600e3 }],
    },
    {
      route: 'zai-coding-cn', displayName: 'GLM Coding', status: 'ok', adapter: 'glm-coding', fetchedAt: NOW - 5000,
      windows: [
        { key: 'rolling', label: '5h', usedPct: 0 }, // 未开始：接口不下发 resetAt
        { key: 'weekly', label: '周', usedPct: 92, resetAt: NOW + 3 * 86400e3 },
      ],
      resets: {
        fiveHour: { count: 2, earliestExpireAt: NOW + 5 * 86400e3 },
        week: { count: 7, earliestExpireAt: NOW + 5 * 86400e3 },
      },
    },
  ],
}
const STATS = {
  generatedAt: new Date(NOW).toISOString(), rangeDays: 7,
  today: { requests: 2, tokens: 600, input: 300, output: 200, cacheRead: 100, cacheWrite: 0, cacheHitRate: 25 },
  week: { requests: 4, tokens: 1500, input: 700, output: 500, cacheRead: 100, cacheWrite: 0, cacheHitRate: 12.5 },
  month: { requests: 9, tokens: 5000, input: 2000, output: 2000, cacheRead: 1000, cacheWrite: 0, cacheHitRate: 33.3 },
  total: { requests: 42, tokens: 30000, input: 12000, output: 12000, cacheRead: 6000, cacheWrite: 0, cacheHitRate: 33.3 },
  heatmap: [{ date: dayKey(1), tokens: 900, requests: 2 }, { date: dayKey(0), tokens: 600, requests: 3 }],
  range: { requests: 4, tokens: 1500, input: 700, output: 500, cacheRead: 100, cacheWrite: 0, cacheHitRate: 12.5 },
  providers: [
    { name: 'kimi1', requests: 3, tokens: 1200, input: 500, output: 400, cacheRead: 100, cacheWrite: 0 },
    { name: 'zai-coding-cn', requests: 1, tokens: 300, input: 200, output: 100, cacheRead: 0, cacheWrite: 0 },
  ],
  models: [
    { name: 'kimi1/kimi-k2', requests: 3, tokens: 1200, input: 500, output: 400, cacheRead: 100, cacheWrite: 0 },
    { name: 'zai-coding-cn/glm-4.6', requests: 1, tokens: 300, input: 200, output: 100, cacheRead: 0, cacheWrite: 0 },
  ],
  conversations: [
    { session: 'sess-aaaa-0001', requests: 2, tokens: 900, input: 500, output: 300, cacheRead: 100, cacheWrite: 0, lastAt: NOW - 1000, providers: ['kimi1'] },
    { session: 'sess-bbbb-0002', requests: 1, tokens: 300, input: 200, output: 100, cacheRead: 0, cacheWrite: 0, lastAt: NOW - 2000, providers: ['zai-coding-cn'] },
    { session: 'session-2c657f21-53bc-4e20-8bdb-6c56718659e3', requests: 1, tokens: 100, input: 60, output: 40, cacheRead: 0, cacheWrite: 0, lastAt: NOW - 3000, providers: ['kimi1'] }, // 无标题：应显示完整 id
  ],
  recent: [{ t: NOW - 30000, p: 'kimi1', m: 'kimi-k2', i: 100, o: 50, cr: 0, cw: 0 }],
  // 与 Host 契约一致：days 首条为今日，从新到旧
  days: [
    { date: dayKey(0), tokens: 600, requests: 2, input: 300, output: 200, cacheRead: 100, cacheWrite: 0 },
    { date: dayKey(1), tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 未使用：应被筛掉
    { date: dayKey(2), tokens: 900, requests: 2, input: 400, output: 250, cacheRead: 50, cacheWrite: 0 },
  ],
}

/** 组装渲染环境：加载 bundle → apply → 取回 slot 组件并渲染。
 *  opts.dom 复用既有 jsdom（验证 localStorage 持久化）；默认全新 dom 并清空偏好。 */
async function renderPlugin(t, opts = {}) {
  const dom = opts.dom || new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  if (!opts.dom) { try { dom.window.localStorage.clear() } catch { /* 测试间偏好隔离 */ } }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { act } = React

  let registered = null
  window.__ModuleLoader__ = { load: (m) => { registered = m } }
  new Function(BUNDLE)() // 与浏览器一致：整包是一个表达式脚本
  const plugin = registered.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })

  const calls = []
  let snapshotCalls = 0
  const ACTIVE_SNAP = opts.snap || SNAP
  const statsReply = opts.statsReply || { ok: true, value: STATS }
  const pricingEnvReply = opts.pricingEnv || {
    rules: { peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00'], ['14:00', '18:00']] },
    holidays: [], years: [2026], error: null,
  }
  const pricingCheckReply = opts.pricingCheck || { checkedAt: Date.now(), ok: true, drift: [] }
  const updateReply = opts.update || { current: '1.0.0', latest: null, hasUpdate: false, autoUpdatable: false }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.endpoint === 'snapshot') {
      // 冷启动用例：可让快照挂起（snapshotGate）或前 N 次失败（snapshotFailures）
      if (opts.snapshotGate) await opts.snapshotGate
      snapshotCalls += 1
      if (opts.snapshotFailures && snapshotCalls <= opts.snapshotFailures) {
        return { ok: false, status: 503, async json() { return { ok: false, error: { message: 'temporarily unavailable' } } } }
      }
      return { ok: true, status: 200, async json() { return { ok: true, value: ACTIVE_SNAP } } }
    }
    if (body.endpoint === 'stats') return { ok: true, status: 200, async json() { return statsReply } }
    if (body.endpoint === 'current') return { ok: true, status: 200, async json() { return { ok: true, value: { route: null } } } }
    if (body.endpoint === 'resetUse') return { ok: true, status: 200, async json() { return { ok: true, value: { status: null } } } }
    if (body.endpoint === 'zcodeAuthState') return { ok: true, status: 200, async json() { return { ok: true, value: { connected: false, source: null, family: null } } } }
    if (body.endpoint === 'zcodeLoginStart') return { ok: true, status: 200, async json() { return { ok: true, value: { url: 'https://bigmodel.cn/login?mock=1', state: 'st-1' } } } }
    if (body.endpoint === 'zcodeLoginComplete') return { ok: true, status: 200, async json() { return { ok: true, value: { connected: true } } } }
    if (body.endpoint === 'pricingEnv') return { ok: true, status: 200, async json() { return { ok: true, value: pricingEnvReply } } }
    if (body.endpoint === 'pricingCheck') return { ok: true, status: 200, async json() { return { ok: true, value: pricingCheckReply } } }
    if (body.endpoint === 'versionCheck') return { ok: true, status: 200, async json() { return { ok: true, value: updateReply } } }
    if (body.endpoint === 'updatePlugin') return { ok: true, status: 200, async json() { return { ok: true, value: { scheduled: true } } } }
    throw new Error('unexpected endpoint ' + body.endpoint)
  }

  let slotComponent = null
  let slotProps = null
  const ctx = {
    effect(fn) { fn() },
    // 可选服务注入（如 pluginNavigation）：仅当用例提供时才触发回调
    inject(deps, fn) {
      if (opts.navigation && Array.isArray(deps) && deps.includes('pluginNavigation')) {
        fn({ pluginNavigation: opts.navigation, effect: (cb) => cb() })
      }
    },
    locale: { register() {} },
    // 可选服务（如浏览器侧模型目录 modelDirectories）：默认没有，按用例注入
    get: (name) => (opts.services || {})[name],
    // 会话服务：列表快照带对话标题（sessionName 解析依赖）；binding 默认返回空对象即可
    sessions: {
      list: {
        getSnapshot: () => ({ byId: {
          'sess-aaaa-0001': { title: '写周报的对话', ...(opts.mainView === false ? {} : { retainedBy: { mainView: 1 } }) },
          'sess-bbbb-0002': { title: '调试插件的对话' },
        } }),
        subscribe: () => () => {},
      },
      binding: opts.binding || (() => ({})),
    },
    slots: {
      inject(name, fn) { fn() },
      register(spec, component) { slotProps = spec.inject(); slotComponent = component; return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.ok(slotComponent, '插件应注册 sidebar.footer.action 组件')

  // React act 环境告警（ticker 秒级触发属预期）降噪，避免淹没断言输出
  const origError = console.error
  console.error = (...a) => { if (!String(a[0]).includes('not wrapped in act')) origError(...a) }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(slotComponent, { ...slotProps, wide: opts.wide !== false })) })
  await act(async () => {}) // 冲刷 snapshot/stats 的微任务与二次渲染

  const click = async (el) => {
    await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
    await act(async () => {})
  }
  let unmounted = false
  const unmount = async () => {
    if (unmounted) return
    unmounted = true
    await act(async () => { root.unmount() })
    console.error = origError
    if (!opts.keepDom) dom.window.close() // 释放 jsdom 定时器，避免进程悬挂
  }
  if (t) t.after(async () => { try { await unmount() } catch {} })
  return { container, calls, click, unmount, dom }
}

const text = (el) => (el ? el.textContent : null)

test('侧栏渲染状态最紧急的供应商卡片（真实 DOM）', async (t) => {
  const { container, unmount } = await renderPlugin(t, )
  const card = container.querySelector('.dmu-pcard')
  assert.ok(card, '侧栏应渲染供应商卡片')
  assert.ok(text(card).includes('GLM Coding'), '应显示状态最紧急的供应商（周窗 92%）')
  assert.ok(card.querySelector('.dmu-win-fill'), '窗口条应渲染')
  assert.ok(text(card).includes('5s'), '刷新时间应显示 5s')
  assert.ok(text(card).includes('调用后开始计时'), '0% 滚动窗无 resetAt 时应提示未开始而非留空')
  await unmount()
})

test('新建对话（无选择）：侧栏卡片立即跟随模型目录默认供应商', async (t) => {
  // 浏览器侧模型目录（与原生输入框同源）：新会话无 modelSelection 记录时 default 即当前模型
  const catalog = {
    catalog: {
      store: {
        getSnapshot: () => ({ value: { default: { provider: 'kimi1' } }, status: 'ready' }),
        subscribe: () => () => {},
      },
    },
  }
  const face = { getSnapshot: () => ({ next: null, lastUsed: null }), subscribe: () => () => {} }
  const { container } = await renderPlugin(t, {
    services: { modelDirectories: catalog },
    binding: () => ({ session: { projections: { faceOf: () => face } } }),
  })
  const card = container.querySelector('.dmu-pcard')
  assert.ok(card, '侧栏应渲染供应商卡片')
  assert.ok(text(card).includes('Kimi 一号'), '新会话无选择时应立即显示默认供应商 kimi1')
  assert.ok(!text(card).includes('GLM Coding'), '不应显示上一会话遗留或状态最紧急的供应商')
})

test('右栏顶部固定摘要：今日/本周/本月/全部 + 近 12 个月热力图', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const summary = overlay.querySelector('.dmu-detail > .dmu-summary')
  assert.ok(summary, '右栏顶部应有固定摘要区')
  const cards = [...summary.querySelectorAll('.dmu-sumcard')]
  assert.equal(cards.length, 4, '应有今日/本周/本月/全部四卡')
  assert.ok(text(cards[0]).includes('今日') && text(cards[0]).includes('600'), '今日卡应显示 600 tokens')
  assert.ok(text(cards[1]).includes('本周') && text(cards[1]).includes('1.5K'), '本周卡应显示 1.5K tokens')
  assert.ok(text(cards[3]).includes('全部') && text(cards[3]).includes('3.0 万'), '全部卡应显示 3.0 万 tokens（中文万进制）')
  assert.ok(!text(summary).includes('用量热力图'), '热力图不应再有标题（仅保留月份信息）')
  const cells = summary.querySelectorAll('.dmu-heat-cell')
  assert.ok(cells.length > 51 * 7, '热力图应渲染近 12 个月（52 周）格子')
  const tips = [...cells].map((c) => c.getAttribute('aria-label') || '')
  assert.ok(tips.some((s) => s.includes('600 tokens') && s.includes('调用 3 次')), '悬停提示应含日期/tokens/调用次数；实际样本: ' + JSON.stringify(tips.filter(Boolean).slice(-4)))
  assert.ok(tips.some((s) => s.includes('0 tokens')), '零用量格也应有提示（占位格可见）')
  assert.ok(!tips.some((s) => s.includes('undefined')), '缺 requests 字段时不应显示 undefined')
  // 月份标签只在每月 1 日所在列：相邻标签间隔应 >= 3 列，不会挤在一起
  const monthLabels = [...summary.querySelectorAll('.dmu-heat-months span')].map((s) => s.textContent)
  const filled = monthLabels.map((t, i) => (t ? i : -1)).filter((i) => i >= 0)
  assert.ok(filled.length >= 10, '近 12 个月应至少有 10 个月份标签，实际 ' + JSON.stringify(monthLabels))
  for (let i = 1; i < filled.length; i++) {
    assert.ok(filled[i] - filled[i - 1] >= 3, '相邻月份标签间距应 >= 3 列（实际 ' + filled.join(',') + '）')
  }
  await unmount()
})

test('热力图悬停提示：悬停显示实测钳位提示，离开消失', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const summary = document.querySelector('.dmu-overlay .dmu-summary')
  const cells = [...summary.querySelectorAll('.dmu-heat-cell')]
  const target = cells.find((c) => (c.getAttribute('aria-label') || '').includes('600 tokens')) // 今日数据格
  assert.ok(target, '应找到今日数据格')
  const { act } = (await import('react')).default
  await act(async () => { target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
  const tip = summary.querySelector('.dmu-heat-tip')
  assert.ok(tip, '悬停应渲染实测提示元素')
  assert.ok(tip.textContent.includes('600 tokens') && tip.textContent.includes('调用 3 次'), '提示内容应为日期/tokens/调用次数')
  await act(async () => { target.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })) })
  assert.ok(!summary.querySelector('.dmu-heat-tip'), '离开后提示应消失')
  await unmount()
})

// clampTipLeft 纯函数：抽取 client.js 内联实现做边界断言
function loadClampTipLeft() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function clampTipLeft')
  const end = src.indexOf('/**', start + 10)
  assert.ok(start > 0 && end > start, 'client.js 应包含 clampTipLeft')
  return new Function(src.slice(start, end) + '\nreturn clampTipLeft')()
}

test('clampTipLeft：按提示宽度钳位在容器内，无布局信息时退化居中', () => {
  const clamp = loadClampTipLeft()
  assert.equal(clamp(400, 200, 960), 300, '中间位置居中')
  assert.equal(clamp(20, 200, 960), 0, '左缘钳到 0')
  assert.equal(clamp(950, 200, 960), 760, '右缘钳到 容器宽-提示宽')
  assert.equal(clamp(50, 2000, 960), 0, '提示比容器还宽时钳到 0')
  assert.equal(clamp(123, 200, 0), 123, '无布局信息（hostW=0）退化为居中')
})

test('模型统计展开后：统一五列信息列；无偏好时默认全收起', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const secs = [...overlay.querySelectorAll('.dmu-sec')]
  assert.equal(secs.length, 4, '应有四个折叠分区（会话/模型/渠道/全局）')
  assert.ok(text(secs[0].querySelector('.dmu-sec-head')).includes('会话统计'), '会话统计应位于模型统计之前')
  assert.ok(secs.every((s) => !s.classList.contains('open')), '无偏好时四个分区应默认全部收起')
  await click(secs[1].querySelector('.dmu-sec-head'))
  // 统一信息列表头：模型 + 调用次数/输入 tokens/缓存 tokens/输出 tokens
  const head = secs[1].querySelector('.dmu-mrow-head')
  assert.deepEqual([...head.children].map((c) => text(c)), ['模型', '调用次数', '输入 tokens', '缓存 tokens', '输出 tokens'])
  const rows = [...secs[1].querySelectorAll('.dmu-mrow-c5:not(.dmu-mrow-head)')]
  assert.equal(rows.length, 2, '模型统计应有两行数据')
  assert.ok(text(rows[0]).includes('kimi-k2'), '模型名应去掉供应商前缀')
  assert.deepEqual([...rows[0].querySelectorAll('.n')].map((n) => text(n)), ['3', '500', '100', '400'], 'kimi-k2 五列数值')
  assert.deepEqual([...rows[1].querySelectorAll('.n')].map((n) => text(n)), ['1', '200', '0', '100'], 'glm-4.6 五列数值')
  // 所有行（含无调用记录的 glm 行）都有 chevron 槽位，模型名称左对齐
  assert.ok(rows[0].querySelector('.dmu-chev svg'), 'kimi-k2 行应有展开 chevron')
  const glmChev = rows[1].querySelector('.dmu-chev')
  assert.ok(glmChev && glmChev.classList.contains('dmu-chev-empty'), '无记录行应有空占位符保持对齐')
  assert.ok(!secs[1].querySelector('.dmu-meter-seg') && !text(secs[1]).includes('%'), '不应再有堆叠条与命中率')
  await unmount()
})

test('会话统计独立分区：五列明细与友好会话名称', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const secs = [...overlay.querySelectorAll('.dmu-sec')]
  assert.ok(text(secs[0].querySelector('.dmu-sec-head')).includes('会话统计'), '分区应命名为会话统计')
  await click(secs[0].querySelector('.dmu-sec-head')) // 默认收起，先展开
  const body = text(secs[0])
  assert.ok(body.includes('写周报的对话'), '首列应展示友好会话名称而非 session id')
  assert.ok(!body.includes('sess-aaaa'), '首列不应直接暴露 session id（有标题时）')
  // 无标题会话：展示完整 id（数据层不截断，换行显示交给 CSS）
  assert.ok(body.includes('session-2c657f21-53bc-4e20-8bdb-6c56718659e3'), '无标题会话应显示完整 session id')
  assert.ok(!body.includes('2c657f21-…') && !body.includes('session-…'), '不应出现数据层省略号')
  // 五列网格：会话/调用/输入 token/缓存 token/输出 token
  const head = secs[0].querySelector('.dmu-mrow-head')
  assert.equal([...head.children].length, 5, '表头应为五列')
  assert.equal(text(head.children[2]), '输入 tokens')
  assert.equal(text(head.children[3]), '缓存 tokens')
  assert.equal(text(head.children[4]), '输出 tokens')
  const firstRow = secs[0].querySelector('.dmu-mrow-c5:not(.dmu-mrow-head)')
  const nums = [...firstRow.querySelectorAll('.n')].map((n) => text(n))
  assert.deepEqual(nums, ['2', '500', '100', '300'], '首行明细应为 调用2/输入500/缓存100/输出300')
  // 首列字重/换行靠 dmu-mtable-convos 变体类（选择器强度压过基础规则）
  assert.ok(secs[0].querySelector('.dmu-mtable.dmu-mtable-convos'), '会话统计应有 dmu-mtable-convos 变体类（常规字重+完整显示）')
  await unmount()
})

test('历史统计：按日统计表日期从新到旧排列', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const secs = [...overlay.querySelectorAll('.dmu-sec')]
  const globalSec = secs[secs.length - 1]
  assert.ok(text(globalSec.querySelector('.dmu-sec-head')).includes('历史统计'), '分区应命名为历史统计')
  await click(globalSec.querySelector('.dmu-sec-head'))
  // 五列网格表头：日期/调用/输入 token/缓存 token/输出 token
  const head = globalSec.querySelector('.dmu-mrow-head')
  assert.ok(head, '历史统计应有网格表头')
  assert.equal([...head.children].length, 5, '表头应为五列')
  assert.equal(text(head.children[1]), '调用次数')
  assert.equal(text(head.children[2]), '输入 tokens')
  const rows = [...globalSec.querySelectorAll('.dmu-mrow-c5:not(.dmu-mrow-head)')]
  assert.equal(rows.length, 2, '未使用日期应被筛掉（夹具含一天零用量）')
  const dayCells = rows.map((r) => text(r.firstElementChild))
  assert.ok(dayCells[0] >= dayCells[1], '日期应从新到旧排列：' + dayCells.join(' vs '))
  const firstNums = [...rows[0].querySelectorAll('.n')].map((n) => text(n))
  assert.deepEqual(firstNums, ['2', '300', '100', '200'], '今日明细应为 调用2/输入300/缓存100/输出200')
  assert.ok(!globalSec.querySelector('.dmu-kpis'), '历史统计不应再有 KPI 卡')
  assert.ok(!globalSec.querySelector('.dmu-recent'), '历史统计不应再有最近请求（已移至模型展开列表）')
  await unmount()
})

test('模型统计：展开模型行显示每次调用明细', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const modelsSec = [...overlay.querySelectorAll('.dmu-sec')][1]
  await click(modelsSec.querySelector('.dmu-sec-head')) // 默认收起，先展开
  const kimiRow = [...modelsSec.querySelectorAll('.dmu-mrow-btn')].find((r) => text(r).includes('kimi-k2'))
  assert.ok(kimiRow && kimiRow.classList.contains('clickable'), 'kimi-k2 行应可展开')
  await click(kimiRow)
  const calls = modelsSec.querySelector('.dmu-mcalls')
  assert.ok(calls, '点击后应展开调用列表')
  // 展开列表与上层同一五列网格：时间 | 调用次数 | 输入 | 缓存 | 输出
  const callRows = [...calls.querySelectorAll('.dmu-mrow-c5')]
  assert.equal(callRows.length, 1, 'kimi-k2 应有一次调用记录')
  assert.ok(text(callRows[0].firstElementChild).includes('30s'), '首列应显示相对时间')
  assert.deepEqual([...callRows[0].querySelectorAll('.n')].map((n) => text(n)), ['1', '100', '0', '50'], '调用行五列数值（1 次/输入 100/缓存 0/输出 50）')
  assert.ok(!calls.querySelector('.dmu-table'), '展开列表不应再用旧 table 布局（与上层网格对齐）')
  // 再次点击收起
  await click(kimiRow)
  assert.ok(!modelsSec.querySelector('.dmu-mcalls'), '再次点击应收起')
  await unmount()
})

test('渠道统计展开：与上层统计同款五列网格（跨分区列对齐）', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const secs = [...overlay.querySelectorAll('.dmu-sec')]
  const channelsSec = secs[2]
  await click(channelsSec.querySelector('.dmu-sec-head'))
  const head = channelsSec.querySelector('.dmu-mrow-head')
  assert.deepEqual([...head.children].map((c) => text(c)), ['供应商', '调用次数', '输入 tokens', '缓存 tokens', '输出 tokens'])
  const rows = [...channelsSec.querySelectorAll('.dmu-mrow-c5:not(.dmu-mrow-head)')]
  assert.equal(rows.length, 2, '渠道统计应有两行')
  assert.deepEqual([...rows[0].querySelectorAll('.n')].map((n) => text(n)), ['3', '500', '100', '400'], 'kimi1 渠道五列数值')
  await unmount()
})

test('统计范围 tabs：今日/本周/本月/全部，按日历口径查询', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const tabs = [...overlay.querySelectorAll('.dmu-tab')].map((b) => text(b))
  assert.deepEqual(tabs, ['今日', '本周', '本月', '全部'], 'tabs 应为今日/本周/本月/全部')
  // 默认全部：days=180 查询
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.days === 180), '默认应发 days=180（全部）查询')
  const active = overlay.querySelector('.dmu-tab.active')
  assert.ok(active && text(active) === '全部', '无偏好时默认选中全部')
  const tabOf = (label) => [...overlay.querySelectorAll('.dmu-tab')].find((b) => text(b) === label)
  await click(tabOf('本周'))
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.scope === 'week'), '本周应发 scope=week 查询')
  await click(tabOf('全部'))
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.days === 180), '全部应发 days=180 查询')
  await unmount()
})

test('偏好持久化：记住上次的 tab 与分区展开态', async (t) => {
  // 第一次渲染：默认应为「全部」；切到「今日」并展开渠道分区
  const env1 = await renderPlugin(t, { keepDom: true })
  await env1.click(env1.container.querySelector('.dmu-pcard'))
  let overlay = document.querySelector('.dmu-overlay')
  assert.ok(text(overlay.querySelector('.dmu-tab.active')) === '全部', '无偏好时默认应为「全部」')
  const tabToday = [...overlay.querySelectorAll('.dmu-tab')].find((b) => text(b) === '今日')
  await env1.click(tabToday)
  const secs1 = [...overlay.querySelectorAll('.dmu-sec')]
  await env1.click(secs1[2].querySelector('.dmu-sec-head'))
  await env1.unmount()

  // 第二次渲染（同一 jsdom/localStorage）：应恢复「今日」（而非默认的全部）+ 渠道展开
  const env2 = await renderPlugin(t, { dom: env1.dom })
  await env2.click(env2.container.querySelector('.dmu-pcard'))
  overlay = document.querySelector('.dmu-overlay')
  const active = overlay.querySelector('.dmu-tab.active')
  assert.ok(active && text(active) === '今日', '重开应恢复上次选择的「今日」而非默认「全部」')
  const secs2 = [...overlay.querySelectorAll('.dmu-sec')]
  assert.ok(secs2[2].classList.contains('open'), '渠道分区应恢复展开')
  assert.ok(!secs2[0].classList.contains('open') && !secs2[1].classList.contains('open'), '未点过的分区仍保持收起')
  await env2.unmount()
})

test('弹窗不再有总览按钮与卡片切换；全部刷新逐路由触发', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const overlay = document.querySelector('.dmu-overlay')
  const tools = [...overlay.querySelectorAll('.dmu-toolbtn')]
  assert.equal(tools.length, 1, '工具栏应只剩全部刷新')
  assert.ok(text(tools[0]).includes('全部刷新'))
  assert.ok(!overlay.querySelector('.dmu-list .dmu-pcard[role="button"]'), '左栏卡片不应再是可点击按钮')
  const before = calls.length
  await click(tools[0])
  const routes = calls.slice(before).filter((c) => c.endpoint === 'snapshot' && c.payload && c.payload.refresh).map((c) => c.payload.route).sort()
  assert.deepEqual(routes, ['kimi1', 'zai-coding-cn'], '应为每个供应商各发一次强制刷新')
  await unmount()
})

test('弹窗头部：检测到新版本时在 GitHub 按钮左侧显示 NEW 标签', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, {
    update: { current: '1.0.0', latest: '1.0.1', hasUpdate: true },
  })
  await click(container.querySelector('.dmu-pcard'))
  const head = document.querySelector('.dmu-modal-head')
  assert.ok(head, '弹窗应打开')
  const tag = head.querySelector('.dmu-update-tag')
  assert.ok(tag, '有新版本时应显示更新标签')
  assert.equal(text(tag), 'NEW v1.0.1', '标签内容为 NEW + 最新版本号')
  assert.ok(String(tag.getAttribute('title')).includes('1.0.1'), '悬停提示应包含新版本号')
  const children = [...head.children]
  const gh = children.find((el) => el.getAttribute('title') === 'GitHub')
  assert.ok(gh && children.indexOf(tag) < children.indexOf(gh), '标签应位于 GitHub 按钮左侧')
  await unmount()
})

test('弹窗头部：点击 NEW 标签打开插件页更新入口并关闭弹窗', async (t) => {
  const opened = []
  const { container, click, unmount } = await renderPlugin(t, {
    update: { current: '1.0.0', latest: '1.0.1', hasUpdate: true },
    navigation: { openBundle: (name) => opened.push(name), openList: () => {} },
  })
  await click(container.querySelector('.dmu-pcard'))
  const tag = document.querySelector('.dmu-update-tag')
  assert.ok(tag, '应显示更新标签')
  assert.equal(tag.tagName, 'BUTTON', '标签应为可点击按钮')
  await click(tag)
  assert.deepEqual(opened, ['@antecer/dsh-model-usage'], '点击应直达本插件的插件页')
  assert.ok(!document.querySelector('.dmu-modal'), '点击后弹窗应关闭')
  await unmount()
})

test('弹窗头部：可自动更新时点击标签调用更新接口并显示更新中', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, {
    update: { current: '1.0.0', latest: '1.0.1', hasUpdate: true, autoUpdatable: true },
  })
  await click(container.querySelector('.dmu-pcard'))
  const tag = document.querySelector('.dmu-update-tag')
  assert.ok(tag, '应显示更新标签')
  assert.ok(String(tag.getAttribute('title')).includes('立即更新'), '可自动更新时提示文案应表明立即更新')
  await click(tag)
  assert.ok(calls.some((c) => c.endpoint === 'updatePlugin'), '点击应调用 updatePlugin 接口')
  assert.equal(text(document.querySelector('.dmu-update-tag')), '更新中…', '更新期间标签应显示更新中')
  await unmount()
})

test('弹窗头部：无新版本时不显示更新标签', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, {
    update: { current: '1.0.1', latest: '1.0.1', hasUpdate: false },
  })
  await click(container.querySelector('.dmu-pcard'))
  assert.ok(document.querySelector('.dmu-modal-head'), '弹窗应打开')
  assert.ok(!document.querySelector('.dmu-update-tag'), '无更新时不应渲染标签')
  await unmount()
})

test('stats 失败：显示具体错误与重试按钮（不再永远加载中）', async (t) => {
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a) }
  try {
    const { container, click, unmount } = await renderPlugin(t, {
      statsReply: { ok: false, error: { code: 'model-usage/internal', message: 'HTTP 500 boom' } },
    })
    await click(container.querySelector('.dmu-pcard'))
    const detail = document.querySelector('.dmu-overlay .dmu-detail')
    const err = detail.querySelector('.dmu-err')
    assert.ok(err, '失败时应显示错误块而非加载中')
    assert.ok(text(err).includes('HTTP 500 boom'), '错误块应包含 Host 返回的错误文本')
    assert.ok([...detail.querySelectorAll('button')].some((b) => text(b) === '重试'), '应提供重试按钮')
    assert.ok(warnings.some((a) => String(a[0]).includes('[dmu-stats]')), '失败应打 [dmu-stats] 标签日志')
    await unmount()
  } finally {
    console.warn = origWarn
  }
})

test('GLM 卡片：账户小按钮 + 窗口重置按钮（含机会数）', async (t) => {
  const { container, unmount } = await renderPlugin(t, )
  const card = container.querySelector('.dmu-pcard')
  // 账户入口做在左上角 Logo 上（.dmu-logo-btn），无额外图标按钮
  const logoBtn = card.querySelector('.dmu-logo-btn')
  assert.ok(logoBtn, 'GLM 卡片 Logo 应为账户入口')
  assert.ok(!logoBtn.classList.contains('connected'), '未连接时应为灰度（无 connected 类）')
  assert.ok(!card.querySelector('.dmu-accountbtn'), '不应再有右下角的账户图标按钮')
  assert.ok(!logoBtn.classList.contains('connected'), '未连接时应为灰度（无 connected 类）')
  assert.ok(!card.querySelector('.dmu-pcard-foot'), '不应有独立的 foot 行（绝对定位不占布局）')
  // 重置按钮渲染在倒计时行最右侧，带机会数
  const feet = [...card.querySelectorAll('.dmu-win-foot')]
  const rollingFoot = feet.find((f) => text(f).includes('调用后开始计时'))
  assert.ok(rollingFoot, '5h 未开始窗口应有提示行')
  const resetBtn = rollingFoot.querySelector('.dmu-resetbtn')
  assert.ok(resetBtn && text(resetBtn).includes('重置 2'), '5h 窗口应有「重置 2」按钮')
  const weeklyFoot = feet.find((f) => text(f).includes('后重置'))
  assert.ok(weeklyFoot && text(weeklyFoot.querySelector('.dmu-resetbtn')).includes('重置 7'), '周窗口应有「重置 7」按钮')
  await unmount()
})

test('可重置额度弹窗（ZCode 同款）：额度卡片 + 重置行 + 核销流程', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-win-foot .dmu-resetbtn'))
  let dialog = document.querySelector('.dmu-dialog')
  assert.ok(dialog, '点击重置应弹出「可重置额度」对话框')
  // 上半：当前额度卡片（5h / 周，剩余百分比 + 色条）
  assert.ok(text(dialog).includes('可重置额度'), '标题应为可重置额度')
  const cards = [...dialog.querySelectorAll('.dmu-quota-card')]
  assert.equal(cards.length, 2, '应有 5h 与周两张额度卡片')
  assert.ok(text(cards[0]).includes('100%'), '5h 未开始应显示剩余 100%')
  assert.ok(text(cards[1]).includes('8%'), '周 92% 已用应显示剩余 8%')
  // 下半：两类重置行（次数药丸 + 重置按钮）
  const rows = [...dialog.querySelectorAll('.dmu-quota-row')]
  assert.equal(rows.length, 2, '应有 5 小时与周两条重置行')
  assert.ok(text(rows[0]).includes('5 小时额度重置') && text(rows[0]).includes('2 次'), '5 小时行应含次数药丸')
  assert.ok(text(rows[1]).includes('周额度重置') && text(rows[1]).includes('7 次'), '周行应含次数药丸')
  // 关闭（X）：不发核销请求
  await click(dialog.querySelector('.dmu-headbtn'))
  assert.ok(!document.querySelector('.dmu-dialog'), '关闭应退出对话框')
  assert.ok(!calls.some((c) => c.endpoint === 'resetUse'), '关闭不应发起核销请求')
  // 重新打开并点 5 小时行的重置按钮
  await click(container.querySelector('.dmu-win-foot .dmu-resetbtn'))
  dialog = document.querySelector('.dmu-dialog')
  await click(dialog.querySelectorAll('.dmu-quota-row')[0].querySelector('.dmu-quota-use'))
  const useCalls = calls.filter((c) => c.endpoint === 'resetUse')
  assert.equal(useCalls.length, 1, '确认应发起一次核销')
  assert.equal(useCalls[0].payload.type, 'FIVE_HOUR', '5 小时行应对应 FIVE_HOUR')
  await new Promise((r) => setTimeout(r, 700)) // 成功打勾 600ms 后自动关闭
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(!document.querySelector('.dmu-dialog'), '成功后对话框应自动关闭')
  assert.ok(calls.some((c) => c.endpoint === 'snapshot' && c.payload && c.payload.refresh), '核销后应强制刷新快照')
  await unmount()
})

test('账户对话框：未连接状态提供去授权入口', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-logo-btn'))
  const dialog = document.querySelector('.dmu-dialog')
  assert.ok(dialog, '账户按钮应打开账户对话框')
  assert.ok(text(dialog).includes('未连接'), '应显示未连接状态')
  const startBtn = [...dialog.querySelectorAll('button')].find((b) => text(b) === '去授权')
  assert.ok(startBtn, '应有去授权按钮')
  await click(startBtn)
  assert.ok(calls.some((c) => c.endpoint === 'zcodeLoginStart'), '应请求授权链接')
  const ta = dialog.querySelector('textarea')
  assert.ok(ta && ta.placeholder.includes('zcode://oauth/callback'), '输入框应提示粘贴回调链接')
  const textarea = dialog.querySelector('textarea')
  assert.ok(textarea, '应有回调链接输入框')
  await unmount()
})

// ---------------------------------------------------------------- 左下角账号菜单联动
// DSH 侧栏左下角账号菜单（settings.launcher）向上弹出时会覆盖本插件的供应商卡片。
// trigger 的 aria-expanded 即菜单开合；插件应在打开期间隐藏卡片、关闭后恢复。

/** 模拟 DSH 侧栏左下角的账号菜单 trigger（与宿主 DOM 契约一致：data-signed-out + aria-haspopup + aria-expanded）。 */
function mockAccountMenuTrigger() {
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('data-signed-out', 'false')
  trigger.setAttribute('aria-expanded', 'false')
  document.body.appendChild(trigger)
  return {
    element: trigger,
    /** 切换菜单开合并冲刷 MutationObserver + React 更新 */
    async set(open, act) {
      await act(async () => {
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
        await new Promise((r) => setTimeout(r, 0))
      })
    },
    remove: () => trigger.remove(),
  }
}

test('左下角账号菜单弹出时隐藏侧栏卡片，关闭后恢复（宽态）', async (t) => {
  const { container, unmount } = await renderPlugin(t, )
  const { act } = (await import('react')).default
  const card = () => container.querySelector('.dmu-footwrap')
  assert.ok(card(), '侧栏应渲染供应商卡片')
  assert.ok(!card().hasAttribute('data-account-menu-open'), '菜单未打开时卡片应可见')

  const menu = mockAccountMenuTrigger()
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  assert.ok(!card().hasAttribute('data-account-menu-open'), 'trigger 存在但菜单关闭时卡片仍应可见')

  await menu.set(true, act)
  assert.ok(card().hasAttribute('data-account-menu-open'), '账号菜单打开时卡片应标记隐藏')

  await menu.set(false, act)
  assert.ok(!card().hasAttribute('data-account-menu-open'), '账号菜单关闭后卡片应恢复显示')
  menu.remove()
  await unmount()
})

test('折叠态左下角账号菜单弹出时隐藏紧凑卡片', async (t) => {
  const { container, unmount } = await renderPlugin(t, { wide: false })
  const { act } = (await import('react')).default
  const compact = () => container.querySelector('.dmu-foot.dmu-foot-compact')
  assert.ok(compact(), '折叠态应渲染紧凑卡片按钮')

  const menu = mockAccountMenuTrigger()
  await menu.set(true, act)
  assert.ok(compact().hasAttribute('data-account-menu-open'), '折叠态账号菜单打开时紧凑卡片也应隐藏')
  await menu.set(false, act)
  assert.ok(!compact().hasAttribute('data-account-menu-open'), '折叠态菜单关闭后紧凑卡片应恢复')
  menu.remove()
  await unmount()
})

test('菜单打开隐藏卡片用 visibility 保留占位（避免菜单与触发按钮错位）', () => {
  const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8')
  const rule = css.match(/\.dmu-footwrap\[data-account-menu-open\][\s\S]{0,240}?\}/)
  assert.ok(rule, 'style.css 应包含菜单打开时隐藏卡片的规则')
  assert.ok(/visibility:\s*hidden/.test(rule[0]), '应使用 visibility: hidden 保留布局占位')
  assert.ok(!/display:\s*none/.test(rule[0]), '不应使用 display: none：侧栏底部收缩会使菜单与触发按钮错位')
})

// ---------------------------------------------------------------- 冷启动首屏
// DSH 冷启动时 Host 要现查各额度接口，首次快照返回前卡片不应空白：
// 无缓存 → 骨架卡片；有上次快照 → 立即回显并标「已过期」；首次请求失败 → 自动重试。

test('冷启动快照未返回：立即渲染骨架卡片，数据到达后替换', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const { container, unmount } = await renderPlugin(t, { snapshotGate: gate })
  const ghost = container.querySelector('.dmu-pcard.dmu-pcard-ghost')
  assert.ok(ghost, '快照返回前应立即渲染骨架卡片（不再空白等待）')
  assert.equal(ghost.getAttribute('aria-label'), '加载中…', '骨架应带加载中提示')
  assert.ok(!container.querySelector('.dmu-pcard:not(.dmu-pcard-ghost)'), '数据未到时不应渲染真实卡片')

  const { act } = (await import('react')).default
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)) })
  assert.ok(!container.querySelector('.dmu-pcard-ghost'), '数据到达后骨架应消失')
  assert.ok(container.querySelector('.dmu-pcard:not(.dmu-pcard-ghost)'), '数据到达后应渲染真实卡片')
  await unmount()
})

test('冷启动折叠态：快照未返回时先渲染骨架按钮', async (t) => {
  const { container, unmount } = await renderPlugin(t, { wide: false, snapshotGate: new Promise(() => {}) })
  assert.ok(container.querySelector('.dmu-foot.dmu-ghost'), '折叠态快照未返回时应渲染骨架按钮')
  await unmount()
})

test('冷启动回显上次快照：卡片立即出现并标「已过期」，新数据到达后替换', async (t) => {
  const env1 = await renderPlugin(t, { keepDom: true })
  assert.ok(env1.container.querySelector('.dmu-pcard'), '首次渲染应渲染真实卡片')
  const cached = env1.dom.window.localStorage.getItem('dmu:snaplast')
  assert.ok(cached, '快照应写入 localStorage 供冷启动回显')
  await env1.unmount()

  let release
  const gate = new Promise((r) => { release = r })
  const env2 = await renderPlugin(t, { dom: env1.dom, snapshotGate: gate })
  const card = env2.container.querySelector('.dmu-pcard:not(.dmu-pcard-ghost)')
  assert.ok(card, '冷启动应回显上次快照的卡片（无需等 Host）')
  assert.ok(text(card).includes('已过期'), '回显数据应标记为已过期')
  const { act } = (await import('react')).default
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)) })
  const fresh = env2.container.querySelector('.dmu-pcard:not(.dmu-pcard-ghost)')
  assert.ok(fresh && !text(fresh).includes('已过期'), '新快照到达后应移除已过期标记')
  await env2.unmount()
})

test('冷启动首次快照失败：有限退避重试，成功后渲染卡片', async (t) => {
  const { container, unmount } = await renderPlugin(t, { snapshotFailures: 1 })
  assert.ok(container.querySelector('.dmu-pcard-ghost'), '首次失败时应保持骨架占位')
  await new Promise((r) => setTimeout(r, 1300)) // 首次重试 500 * 2^1 = 1s
  const { act } = (await import('react')).default
  await act(async () => {})
  assert.ok(container.querySelector('.dmu-pcard:not(.dmu-pcard-ghost)'), '重试成功后应渲染真实卡片')
  await unmount()
})

// ---------------------------------------------------------------- 峰谷提示 / 官方价格校验
// DeepSeek 官方计费规则：工作日 9:00-12:00、14:00-18:00 为高峰，其余（含周末/节假日全天）为空闲。
// 侧栏 DeepSeek 卡片底部显示「当前为梁文谷/梁文峰时段，距离…还有 Xh」；官方价格表变动时弹窗提示。

/** 从发布产物的内联实现抽取峰谷计算（单文件交付约束，无独立模块可 import）。 */
function loadPeakFns() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const BJ_OFFSET')
  const end = src.indexOf('// ---------------------------------------------------------------- 快照首屏', start)
  assert.ok(start > 0 && end > start, 'client.js 应包含峰谷计算块')
  return new Function(src.slice(start, end) + '\nreturn { peakInfo, formatPeakLeft }')()
}

const DEEPSEEK_SNAP = {
  generatedAt: NOW, refreshSeconds: 60, card: { template: '' },
  providers: [{
    route: 'deepseek-official', displayName: 'DeepSeek', adapter: 'deepseek-balance',
    status: 'ok', valid: true, fetchedAt: NOW,
    balance: { currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' },
  }],
}

test('峰谷计算：工作日窗口/午休/晚间/周末/节假日与剩余时间格式', () => {
  const { peakInfo, formatPeakLeft } = loadPeakFns()
  const rules = { peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00'], ['14:00', '18:00']] }
  const none = new Set()
  const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi)
  // 2026-10-26 周一 10:00 → 高峰，12:00 结束
  assert.deepEqual(peakInfo(at(2026, 10, 26, 10, 0), rules, none), { peak: true, changeAt: at(2026, 10, 26, 12, 0) })
  // 周一 12:30（午休）→ 空闲，14:00 转高峰
  assert.deepEqual(peakInfo(at(2026, 10, 26, 12, 30), rules, none), { peak: false, changeAt: at(2026, 10, 26, 14, 0) })
  // 周一 18:30 → 空闲，次日 09:00 转高峰
  assert.deepEqual(peakInfo(at(2026, 10, 26, 18, 30), rules, none), { peak: false, changeAt: at(2026, 10, 27, 9, 0) })
  // 周五 19:00 → 空闲，下周一 09:00（跳过周末）
  assert.deepEqual(peakInfo(at(2026, 10, 30, 19, 0), rules, none), { peak: false, changeAt: at(2026, 11, 2, 9, 0) })
  // 国庆（10-01 周四）全天空闲 → 下一峰 10-08 周四 09:00
  const holidays = new Set(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'])
  assert.deepEqual(peakInfo(at(2026, 10, 1, 10, 0), rules, holidays), { peak: false, changeAt: at(2026, 10, 8, 9, 0) })
  // 剩余时间格式
  assert.equal(formatPeakLeft(2 * 3600e3), '2h')
  assert.equal(formatPeakLeft(1.5 * 3600e3), '1h30m')
  assert.equal(formatPeakLeft(45 * 60e3), '45m')
})

test('侧栏 DeepSeek 卡片：大数字按峰/谷着色，倒计时并入充值行右对齐', async (t) => {
  const { container, unmount } = await renderPlugin(t, { snap: DEEPSEEK_SNAP })
  const { act } = (await import('react')).default
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const big = container.querySelector('.dmu-pcard .dmu-big')
  assert.ok(big, 'DeepSeek 卡片应渲染中间大数字')
  assert.match(big.className, /\bdmu-price-(peak|valley)\b/, '大数字应有峰（红）/谷（绿）配色类')
  const bigText = container.querySelector('.dmu-pcard .dmu-bigtext')
  assert.ok(bigText, '大数字应有贴合文字的内层悬停区')
  // 悬停判定只认文字：整行空白处（.dmu-big 容器）不触发
  await act(async () => {
    big.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, clientX: 320, clientY: 400 }))
    await new Promise((r) => setTimeout(r, 0))
  })
  assert.ok(!container.querySelector('.dmu-peak-tip'), '悬停大数字整行空白处不应显示提示')
  // 自绘提示：悬停文字时显示在鼠标指针上方，左下角对齐指针
  await act(async () => {
    bigText.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, clientX: 320, clientY: 400 }))
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {})
  const tip = container.querySelector('.dmu-peak-tip')
  assert.ok(tip, '悬停大数字文字应显示自绘提示')
  assert.equal(tip.getAttribute('role'), 'tooltip', '提示应有 tooltip 语义')
  assert.match(text(tip), /^当前时段：梁文(峰|谷)$/, '提示内容为当前时段')
  assert.equal(tip.style.left, '320px', '提示左下角水平对齐指针')
  assert.equal(tip.style.top, '394px', '提示显示在指针上方（留 6px 间距）')
  await act(async () => {
    bigText.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
  assert.ok(!container.querySelector('.dmu-peak-tip'), '鼠标移出文字后提示消失')
  const row = container.querySelector('.dmu-pcard .dmu-balrow')
  assert.ok(row, '充值/赠金行应渲染')
  assert.ok(text(row).includes('充值'), '倒计时应与充值说明在同一行')
  const count = row.querySelector('.dmu-peak-count')
  assert.ok(count, '同一行右侧应有倒计时')
  assert.match(text(count), /^\d+[hm]/, '倒计时只显示时长（如 2h / 1h30m / 45m）')
  await unmount()
})

test('非 DeepSeek 供应商卡片不应用峰谷样式', async (t) => {
  const { container, unmount } = await renderPlugin(t, )
  assert.ok(container.querySelector('.dmu-pcard'), '应有供应商卡片')
  assert.equal(container.querySelector('.dmu-price-peak, .dmu-price-valley'), null, 'Kimi/GLM 大数字不应着色')
  assert.equal(container.querySelector('.dmu-peak-count'), null, 'Kimi/GLM 卡片不应显示倒计时')
  await unmount()
})

test('弹窗左列 DeepSeek 卡片同样应用峰谷配色与倒计时', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, { snap: DEEPSEEK_SNAP })
  await click(container.querySelector('.dmu-pcard'))
  const list = document.querySelector('.dmu-overlay .dmu-list')
  assert.ok(list, '弹窗左列应渲染')
  const big = list.querySelector('.dmu-pcard .dmu-big')
  assert.match(big.className, /\bdmu-price-(peak|valley)\b/, '面板列表卡片的大数字也应着色')
  const count = list.querySelector('.dmu-pcard .dmu-peak-count')
  assert.ok(count, '面板列表卡片也应显示倒计时')
  const row = list.querySelector('.dmu-pcard .dmu-balrow')
  assert.ok(row && row.contains(count), '倒计时与充值说明同一行')
  await unmount()
})

test('官方价格变动：弹窗列出差异，关闭后同一差异不再重复弹', async (t) => {
  const drift = [{ field: 'models.deepseek-flash.output.peak', config: 8, official: 9 }]
  const reply = { checkedAt: Date.now(), ok: true, drift }
  const { act } = (await import('react')).default
  const env1 = await renderPlugin(t, { keepDom: true, pricingCheck: reply })
  await new Promise((r) => setTimeout(r, 1700)) // pricingCheck 在 mount 1.5s 后请求
  await act(async () => {})
  const dialog = document.querySelector('.dmu-dialog')
  assert.ok(dialog, '价格差异应弹出提示弹窗')
  assert.ok(text(dialog).includes('官方价格表已变动'), '弹窗标题应为官方价格表已变动')
  const row = dialog.querySelector('.dmu-drift-row')
  assert.ok(row && text(row).includes('models.deepseek-flash.output.peak'), '应列出差异字段')
  const btn = [...dialog.querySelectorAll('button')].find((b) => text(b) === '知道了')
  assert.ok(btn, '应有「知道了」按钮')
  await env1.click(btn)
  assert.ok(!document.querySelector('.dmu-dialog'), '关闭后弹窗消失')
  await env1.unmount()

  // 同一 localStorage：相同差异不再弹
  const env2 = await renderPlugin(t, { dom: env1.dom, pricingCheck: reply })
  await new Promise((r) => setTimeout(r, 1700))
  await act(async () => {})
  assert.ok(!document.querySelector('.dmu-dialog'), '相同差异关闭后不再重复提示')
  await env2.unmount()
})

test('弹窗左列：全部刷新按钮固定在滚动区外，卡片列表单独滚动', async (t) => {
  const { container, click, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-pcard'))
  const list = document.querySelector('.dmu-overlay .dmu-list')
  assert.ok(list, '弹窗左列应渲染')
  const first = list.firstElementChild
  assert.ok(first && first.classList.contains('dmu-toolbar'), '左列第一个子元素应是全部刷新工具栏（固定在滚动区外）')
  const scroll = list.querySelector('.dmu-list-scroll')
  assert.ok(scroll, '卡片列表应有独立滚动区')
  assert.ok(!scroll.contains(first), '工具栏不应包含在滚动区内')
  assert.ok(scroll.querySelector('.dmu-pcard'), '供应商卡片应在滚动区内')
  await unmount()
})
