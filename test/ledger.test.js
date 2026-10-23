import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import createLedger from '../lib/ledger.mjs'

// 旧版账本的 provider 条目：桶字段平铺、无 { total, models } 包装（2026-10-22 前的格式）。
// stats/record 若直接读 pv.total 会抛 TypeError，stats 端点整体报错，
// 前端表现为右栏永远「加载中」。
function oldFormatFixture() {
  const today = new Date()
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  return {
    version: 1,
    days: {
      [key(y)]: {
        hours: {},
        providers: {
          kimi1: { requests: 5, tokens: 500, input: 300, output: 200, cacheRead: 0, cacheWrite: 0, models: { k2: { requests: 5, tokens: 500, input: 300, output: 200, cacheRead: 0, cacheWrite: 0 } } },
        },
      },
      [key(today)]: {
        hours: {},
        providers: {
          kimi1: { total: { requests: 2, tokens: 100, input: 60, output: 40, cacheRead: 0, cacheWrite: 0 }, models: {} },
        },
      },
    },
    recent: [],
  }
}

function withLedgerFile(t, fixture) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dmu-ledger-'))
  const file = path.join(dir, 'ledger.json')
  writeFileSync(file, JSON.stringify(fixture), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return file
}

test('旧版平铺桶格式的账本：stats 跨天聚合不抛错且计入旧数据', async (t) => {
  const ledger = createLedger({ file: withLedgerFile(t, oldFormatFixture()) })
  await ledger.ready()
  const s = ledger.stats({ days: 7 })
  const kimi = s.providers.find((p) => p.name === 'kimi1')
  assert.ok(kimi, '聚合结果应包含 kimi1')
  assert.equal(kimi.requests, 7, '旧格式 5 + 新格式 2 应合并计入')
  assert.equal(kimi.tokens, 600)
  assert.equal(s.range.requests, 7)
})

test('旧版格式账本：record 向旧条目所在日期记帐不抛错', async (t) => {
  const ledger = createLedger({ file: withLedgerFile(t, oldFormatFixture()) })
  await ledger.ready()
  ledger.record({ time: Date.now(), provider: 'kimi1', model: 'k3', usage: { input: 10, output: 5 } })
  const s = ledger.stats({ days: 1 })
  const kimi = s.providers.find((p) => p.name === 'kimi1')
  assert.equal(kimi.requests, 3, '新格式 2 + 本次 1')
  await ledger.flush()
})

test('stats 摘要字段：today/month/total 独立汇总，heatmap 覆盖 182 天', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dmu-ledger-'))
  const file = path.join(dir, 'ledger.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = createLedger({ file })
  await ledger.ready()
  ledger.record({ time: Date.now(), provider: 'kimi1', model: 'k2', usage: { input: 100, output: 50 }, session: 's1' })
  const s = ledger.stats({ days: 7 })
  assert.equal(s.today.requests, 1)
  assert.equal(s.month.requests, 1, '本月应包含今日')
  assert.equal(s.total.requests, 1)
  assert.equal(s.today.input, 100, 'sumRange 应带完整桶字段')
  assert.equal(s.heatmap.length, 364, '热力图应覆盖近 12 个月（52 周）')
  assert.equal(s.heatmap[s.heatmap.length - 1].tokens, 150, '热力图末格为今日')
  assert.deepEqual(s.conversations, [{ session: 's1', requests: 1, tokens: 150, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, lastAt: s.conversations[0].lastAt, providers: ['kimi1'] }], '按对话聚合应输出会话维度（含输入/输出/缓存桶字段）')
  await ledger.flush()
})

test('损坏条目（null/非对象）被丢弃而非拖垮 stats', async (t) => {
  const fixture = oldFormatFixture()
  const dk = Object.keys(fixture.days)[0]
  fixture.days[dk].providers.broken = null
  fixture.days[dk].providers.alsoBroken = 42
  const ledger = createLedger({ file: withLedgerFile(t, fixture) })
  await ledger.ready()
  const s = ledger.stats({ days: 7 })
  assert.equal(s.providers.length, 1, '损坏条目应被丢弃')
})
