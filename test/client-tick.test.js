import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------- 被测对象
// 插件客户端必须单文件交付（ModuleLoader 按包名注册，无相对模块解析），
// createTicker 的唯一实现内联在 lib/client.js 中。
// 这里直接抽取内联副本执行，保证测试跑的就是发布产物里的代码。

function loadInlineTicker() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function createTicker')
  const end = src.indexOf('const relTicker', start)
  assert.ok(start > 0 && end > start, 'client.js 应内联 createTicker')
  return new Function(src.slice(start, end) + '\nreturn createTicker')()
}

const createTicker = loadInlineTicker()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('ticker：订阅后按间隔触发，退订清零即停止', async () => {
  const ticker = createTicker(10)
  let a = 0
  let b = 0
  const offA = ticker.add(() => { a++ })
  const offB = ticker.add(() => { b++ })
  await sleep(80) // 宽余量：全量并行跑时定时器可能被挤占
  assert.ok(a >= 2, '应按间隔触发多次，实际 ' + a)
  assert.equal(a, b, '多个订阅者同步触发')

  offA()
  ticker.remove(() => {}) // 移除未知监听无副作用
  const before = b
  await sleep(40)
  assert.ok(b > before, '仍有订阅者时继续触发')

  offB()
  assert.equal(ticker.size, 0)
  const stopped = b
  await sleep(30)
  assert.equal(b, stopped, '退订清零后停止')
})

test('ticker：全部退订后计时器停止', async () => {
  const ticker = createTicker(10)
  let n = 0
  const off = ticker.add(() => { n++ })
  await sleep(40) // 宽余量：同上
  assert.ok(n >= 1)
  off()
  assert.equal(ticker.size, 0)
  const stopped = n
  await sleep(30)
  assert.equal(n, stopped, '退订清零后不再触发')
})

test('ticker：fire() 手动触发且监听器异常不影响其他监听器', () => {
  const ticker = createTicker(60000)
  let good = 0
  ticker.add(() => { throw new Error('boom') })
  ticker.add(() => { good++ })
  ticker.fire()
  assert.equal(good, 1)
  ticker.fire()
  assert.equal(good, 2)
})

// ---------------------------------------------------------------- 接线
// 卡片的两处相对时间文本都必须走 useTickText，否则不会每秒平滑更新。

test('client.js：刷新时间与重置倒计时都接入秒级 ticker', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('useTickText(() => relTime(p.fetchedAt))'), 'ProviderCard 的 ago 应走 useTickText')
  assert.ok(src.includes('useTickText(() => fmtReset(w.resetAt, tr))'), 'WinRow 的 reset 应走 useTickText')
})

// relTime 不足 1 秒时不显示（空串），从 1s 起连续计数；
// 历史上两个极端都修过：s<10 空白导致跳变、强制 1s 导致「1s」挂两秒。
function loadInlineRelTime() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function relTime')
  const end = src.indexOf('//', src.indexOf('return Math.floor(s / 3600)', start))
  assert.ok(start > 0 && end > start, 'client.js 应包含 relTime')
  return new Function(src.slice(start, end) + '\nreturn relTime')()
}

test('relTime：不足 1s 不显示，从 1s 起连续计数', () => {
  const relTime = loadInlineRelTime()
  const now = Date.now()
  assert.equal(relTime(now), '') // 刚刷新不足 1s：不显示，而非强制 1s
  assert.equal(relTime(now - 900), '')
  assert.equal(relTime(now - 1200), '1s') // 留 200ms 余量，避免定时器边界抖动
  assert.equal(relTime(now - 3000), '3s')
  assert.equal(relTime(now - 9000), '9s')
  assert.equal(relTime(now - 10000), '10s')
  assert.equal(relTime(now - 59000), '59s')
  assert.equal(relTime(now - 61000), '1m')
  assert.equal(relTime(now - 3700000), '1h')
  assert.equal(relTime(0), '')
  assert.equal(relTime(now + 5000), '') // 时钟微偏负值同样不显示
})
