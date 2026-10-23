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
  const statsReply = opts.statsReply || { ok: true, value: STATS }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.endpoint === 'snapshot') return { ok: true, status: 200, async json() { return { ok: true, value: SNAP } } }
    if (body.endpoint === 'stats') return { ok: true, status: 200, async json() { return statsReply } }
    if (body.endpoint === 'current') return { ok: true, status: 200, async json() { return { ok: true, value: { route: null } } } }
    if (body.endpoint === 'resetUse') return { ok: true, status: 200, async json() { return { ok: true, value: { status: null } } } }
    if (body.endpoint === 'zcodeAuthState') return { ok: true, status: 200, async json() { return { ok: true, value: { connected: false, source: null, family: null } } } }
    if (body.endpoint === 'zcodeLoginStart') return { ok: true, status: 200, async json() { return { ok: true, value: { url: 'https://bigmodel.cn/login?mock=1', state: 'st-1' } } } }
    if (body.endpoint === 'zcodeLoginComplete') return { ok: true, status: 200, async json() { return { ok: true, value: { connected: true } } } }
    throw new Error('unexpected endpoint ' + body.endpoint)
  }

  let slotComponent = null
  let slotProps = null
  const ctx = {
    effect(fn) { fn() },
    locale: { register() {} },
    // 会话服务：列表快照带对话标题（sessionName 解析依赖）；binding 返回空对象即可
    sessions: {
      list: {
        getSnapshot: () => ({ byId: {
          'sess-aaaa-0001': { title: '写周报的对话' },
          'sess-bbbb-0002': { title: '调试插件的对话' },
        } }),
        subscribe: () => () => {},
      },
      binding: () => ({}),
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
  await act(async () => { root.render(React.createElement(slotComponent, { ...slotProps, wide: true })) })
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
  const tips = [...cells].map((c) => c.getAttribute('data-tip') || '')
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
  // 默认今日：days=1 查询
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.days === 1), '默认应发 days=1（今日）查询')
  const active = overlay.querySelector('.dmu-tab.active')
  assert.ok(active && text(active) === '今日', '无偏好时默认选中今日')
  const tabOf = (label) => [...overlay.querySelectorAll('.dmu-tab')].find((b) => text(b) === label)
  await click(tabOf('本周'))
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.scope === 'week'), '本周应发 scope=week 查询')
  await click(tabOf('全部'))
  assert.ok(calls.some((c) => c.endpoint === 'stats' && c.payload && c.payload.days === 180), '全部应发 days=180 查询')
  await unmount()
})

test('偏好持久化：记住上次的 tab 与分区展开态', async (t) => {
  // 第一次渲染：切到「全部」并展开渠道分区
  const env1 = await renderPlugin(t, { keepDom: true })
  await env1.click(env1.container.querySelector('.dmu-pcard'))
  let overlay = document.querySelector('.dmu-overlay')
  const tabAll = [...overlay.querySelectorAll('.dmu-tab')].find((b) => text(b) === '全部')
  await env1.click(tabAll)
  const secs1 = [...overlay.querySelectorAll('.dmu-sec')]
  await env1.click(secs1[2].querySelector('.dmu-sec-head'))
  await env1.unmount()

  // 第二次渲染（同一 jsdom/localStorage）：应恢复「全部」+ 渠道展开
  const env2 = await renderPlugin(t, { dom: env1.dom })
  await env2.click(env2.container.querySelector('.dmu-pcard'))
  overlay = document.querySelector('.dmu-overlay')
  const active = overlay.querySelector('.dmu-tab.active')
  assert.ok(active && text(active) === '全部', '重开应恢复上次选择的「全部」')
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

test('重置二次确认弹窗：可取消；确认后调用 resetUse 并刷新', async (t) => {
  const { container, click, calls, unmount } = await renderPlugin(t, )
  await click(container.querySelector('.dmu-win-foot .dmu-resetbtn'))
  let dialog = document.querySelector('.dmu-dialog')
  assert.ok(dialog, '点击重置应弹出确认对话框')
  assert.ok(text(dialog).includes('确认重置 5 小时额度'), '对话框应说明重置后果')
  assert.ok(text(dialog).includes('剩余 2 次机会'), '对话框应显示剩余机会数')
  // 取消：对话框关闭且不发请求
  await click([...dialog.querySelectorAll('button')].find((b) => text(b) === '取消'))
  assert.ok(!document.querySelector('.dmu-dialog'), '取消应关闭对话框')
  assert.ok(!calls.some((c) => c.endpoint === 'resetUse'), '取消不应发起核销请求')
  // 重新打开并确认
  await click(container.querySelector('.dmu-win-foot .dmu-resetbtn'))
  dialog = document.querySelector('.dmu-dialog')
  await click([...dialog.querySelectorAll('button')].find((b) => text(b) === '确认重置'))
  const useCalls = calls.filter((c) => c.endpoint === 'resetUse')
  assert.equal(useCalls.length, 1, '确认应发起一次核销')
  assert.equal(useCalls[0].payload.type, 'FIVE_HOUR', '5h 窗口应对应 FIVE_HOUR')
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
