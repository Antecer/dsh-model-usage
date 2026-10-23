import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 每卡片独立刷新：busy 按路由管理，互不影响。
// 客户端是单文件手写 bundle，这里用文本级接线断言防回归
// （React 组件渲染测试成本高，接线错误历史上真实出现过）。

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('useSnapshot 用按路由的 busy 集合替代全局 busy', () => {
  assert.ok(src.includes('const [busySet, setBusySet] = useState('), 'useSnapshot 应维护 busySet')
  assert.ok(src.includes('new Set(s).add(route)'), 'refresh 应按路由加入 busySet')
  assert.ok(src.includes('isBusy'), 'useSnapshot 应暴露 isBusy')
  assert.ok(!src.includes('const [busy, setBusy] = useState(false)'), '不应再有全局 busy')
})

test('弹窗列表与侧栏卡片的 busy 都按各自路由取值', () => {
  assert.ok(src.includes('busy: isBusy(p.route)'), '弹窗列表卡片应按 p.route 取 busy')
  assert.ok(src.includes('busy: isBusy(shown.route)'), '侧栏卡片应按 shown.route 取 busy')
  assert.ok(!src.includes('key: p.route, p, tr, template, busy,'), '弹窗列表不应再透传全局 busy')
})

test('refresh 强制刷新携带目标路由（Host 端按路由单飞）', () => {
  assert.ok(src.includes('if (route) opts.route = route'), 'load 应把 route 传给快照请求')
})

test('每个卡片独立计时循环：定时器按路由排定，查询耗时不计入间隔', () => {
  assert.ok(!src.includes('setInterval(tick'), '不应再有全局轮询 interval')
  assert.ok(src.includes('nextAt.current.set(route, Date.now() +'), '下一轮计时应从查询完成时刻起算')
  assert.ok(src.includes('refresh(p.route, false)'), '到点应自动按路由重新查询')
  assert.ok(src.includes('inflight.current.get(route)'), '同路由并发刷新应合并，避免定时与手动重复请求')
})

test('弹窗左栏工具栏：全部刷新按路由逐个触发（无切换/总览按钮）', () => {
  assert.ok(src.includes('for (const p of providers) refresh(p.route)'), '全部刷新应按路由逐个触发（复用各路由的单飞合并）')
  assert.ok(!src.includes('setSelected'), '右栏统一统计视图，不应再有卡片切换状态')
  assert.ok(!src.includes("tr('overview')"), '用量总览按钮应已移除')
})

test('右栏：固定摘要 + 折叠分区结构', () => {
  assert.ok(src.includes('function SummaryTop'), '应有固定顶部摘要组件')
  assert.ok(src.includes('function Heatmap'), '应有近 12 个月热力图组件')
  assert.ok(src.includes('dmu-pane-scroll'), '下半部分应为独立滚动区')
  assert.ok(src.includes("tr('secConversations')") && src.includes("tr('secModels')") && src.includes("tr('secChannels')") && src.includes("tr('secGlobal')"), '应有会话/模型/渠道/历史四个折叠分区')
  assert.ok(src.includes('stats.conversations'), '会话统计应消费按对话聚合数据')
})

test('统计加载失败必须可见（不再永远停在加载中）', () => {
  assert.ok(src.includes("'[dmu-stats] 统计加载失败:'"), 'useStats 失败应打带标签的日志')
  assert.ok(src.includes("tr('retry')"), '失败态应提供重试按钮')
})

test('余量配色按 60/30/5 阈值 if 链短路', () => {
  assert.ok(src.includes('left >= 60'), '余量 >=60% 应为蓝色')
  assert.ok(src.includes('left >= 30'), '余量 >=30% 应为绿色')
  assert.ok(src.includes('left >= 5'), '余量 >=5% 应为橘色')
  assert.ok(!src.includes("'hsl(' + hue +"), '不应再使用连续渐变配色')
})
