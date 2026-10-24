import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { compareVersions, createVersionService } from '../lib/version.mjs'

// ---------------------------------------------------------------- 版本检查
// 覆盖：语义化版本比较、市场索引/npm 取最新、本机版本来源、缓存与单飞、
// 网络失败静默降级。全部用注入的 mock fetch，不触碰真实网络。

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCAL = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** patch 段 +1（用于构造「更高版本」） */
function bump(v) {
  const parts = String(v).split('.').map(Number)
  parts[2] += 1
  return parts.join('.')
}

/** 注入 mock fetch：按 URL 返回给定 JSON，记录调用次数 */
function mockFetch(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const body = handler(String(url))
    if (body instanceof Error) throw body
    return { ok: true, status: 200, async json() { return body } }
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

test('compareVersions：按主/次/修订数字比较，非法输入视为相等', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, '次版本按数字而非字典序比较')
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1, '修订号按数字比较')
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareVersions('garbage', '1.0.0'), 0, '无法解析视为相等（不误报更新）')
  assert.equal(compareVersions(null, '1.0.0'), 0)
})

test('版本检查：市场索引版本更高时报有更新，并给出 npm 安装 spec', async (t) => {
  const next = bump(LOCAL)
  const latest = { plugins: [{ name: '@antecer/dsh-model-usage', versions: [{ version: LOCAL }, { version: next }] }] }
  const calls = mockFetch(t, (url) => (url.includes('index.json') ? latest : { version: LOCAL }))
  const svc = createVersionService(ROOT)
  const r = await svc.check()
  assert.deepEqual(r, { current: LOCAL, latest: next, hasUpdate: true, spec: '@antecer/dsh-model-usage@' + next })
  assert.equal(calls.length, 2, '应同时查询市场索引与 npm')
})

test('版本检查：市场 git 来源转换为固定 commit 的 github 安装 spec', async (t) => {
  const next = bump(LOCAL)
  const commit = 'a'.repeat(40)
  const latest = {
    plugins: [{
      name: '@antecer/dsh-model-usage',
      versions: [{
        version: next,
        source: { type: 'git', url: 'https://github.com/Antecer/dsh-model-usage', commit },
      }],
    }],
  }
  mockFetch(t, (url) => (url.includes('index.json') ? latest : { version: '0.0.1' }))
  const r = await createVersionService(ROOT).check()
  assert.equal(r.spec, 'github:Antecer/dsh-model-usage#' + commit)
})

test('版本检查：npm 版本更高时取 npm 最新', async (t) => {
  const next = bump(LOCAL)
  mockFetch(t, (url) => (url.includes('index.json') ? { plugins: [{ versions: [{ version: LOCAL }] }] } : { version: next }))
  const r = await createVersionService(ROOT).check()
  assert.equal(r.latest, next)
  assert.equal(r.hasUpdate, true)
  assert.equal(r.spec, '@antecer/dsh-model-usage@' + next, 'npm 来源应给出精确版本的 spec')
})

test('版本检查：市场与 npm 都不高于本机时无更新', async (t) => {
  mockFetch(t, (url) => (url.includes('index.json')
    ? { plugins: [{ versions: [{ version: LOCAL }] }] }
    : { version: '0.9.0' }))
  const r = await createVersionService(ROOT).check()
  assert.equal(r.latest, LOCAL)
  assert.equal(r.hasUpdate, false)
})

test('版本检查：默认 30 分钟缓存，force 才重新请求', async (t) => {
  const calls = mockFetch(t, (url) => (url.includes('index.json')
    ? { plugins: [{ versions: [{ version: LOCAL }] }] }
    : { version: LOCAL }))
  const svc = createVersionService(ROOT)
  await svc.check()
  assert.equal(calls.length, 2)
  await svc.check()
  assert.equal(calls.length, 2, '缓存期内不应重复请求')
  await svc.check(true)
  assert.equal(calls.length, 4, 'force 应重新检查')
})

test('版本检查：网络异常静默降级为无更新', async (t) => {
  mockFetch(t, () => new Error('network down'))
  const r = await createVersionService(ROOT).check()
  // 本地版本仍可读，远程来源失败 → latest 为 null、不报更新
  assert.deepEqual(r, { current: LOCAL, latest: null, hasUpdate: false, spec: null })
})

test('版本检查：并发调用单飞，只请求一轮', async (t) => {
  const calls = mockFetch(t, (url) => (url.includes('index.json')
    ? { plugins: [{ versions: [{ version: LOCAL }] }] }
    : { version: LOCAL }))
  const svc = createVersionService(ROOT)
  const [a, b] = await Promise.all([svc.check(), svc.check()])
  assert.deepEqual(a, b)
  assert.equal(calls.length, 2, '并发调用应复用同一轮请求')
})
