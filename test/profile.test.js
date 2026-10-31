import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { profileProviders, invalidateProfileCache } from '../lib/profile.mjs'

// 自造 profile 与环境，不读取用户真实配置或凭据。
const root = mkdtempSync(path.join(tmpdir(), 'dmu-profile-'))
const savedEnv = Object.fromEntries(['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_PROFILE'].map((key) => [key, process.env[key]]))
let caseId = 0
let home
beforeEach(() => {
  home = path.join(root, String(++caseId))
  process.env.DSH_HOME = home
  delete process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE
  invalidateProfileCache()
})
after(() => {
  invalidateProfileCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  assert.ok(path.basename(root).startsWith('dmu-profile-'))
  rmSync(root, { recursive: true })
})

function writeProfile(name, providers, file = 'cordis.yml') {
  const dir = path.join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  const lines = ['plugins:', '  pi-ai:', '    providers:']
  for (const [route, config] of Object.entries(providers)) {
    lines.push(`      ${route}:`)
    for (const [key, value] of Object.entries(config)) lines.push(`        ${key}: ${value}`)
  }
  writeFileSync(path.join(dir, file), lines.join('\n') + '\n')
  return dir
}

test('相同路由出现在不同 profile：最高分并列不任意选择', async () => {
  writeProfile('account-a', { glm: { apiKeyEnv: 'FIXTURE_KEY_A' } })
  writeProfile('account-b', { glm: { apiKeyEnv: 'FIXTURE_KEY_B' } })
  assert.deepEqual(await profileProviders(['glm']), {})
})

test('Host 显式目录优先于环境变量与扫描，不串用同名路由', async () => {
  const a = writeProfile('account-a', { glm: { apiKeyEnv: 'FIXTURE_KEY_A' } })
  const b = writeProfile('account-b', { glm: { apiKeyEnv: 'FIXTURE_KEY_B' } })
  process.env.DSH_PROFILE_DIR = a
  process.env.DSH_PROFILE = 'account-a'
  assert.deepEqual(await profileProviders(['glm'], b), { glm: { apiKeyEnv: 'FIXTURE_KEY_B' } })
  assert.deepEqual(await profileProviders(['glm']), { glm: { apiKeyEnv: 'FIXTURE_KEY_A' } })
  assert.deepEqual(await profileProviders(['glm'], path.join(home, 'missing')), {})
})

test('先读基础配置再合并 patch，同路由仅覆盖 patch 指定字段', async () => {
  const dir = writeProfile('patched', {
    glm: { apiKeyEnv: 'BASE_KEY', baseURL: 'https://base.invalid', displayName: 'Base' },
    baseOnly: { apiKeyEnv: 'BASE_ONLY' },
  })
  writeProfile('patched', {
    glm: { apiKeyEnv: 'PATCH_KEY', baseURL: 'https://patch.invalid' },
    patchOnly: { displayName: 'Patch' },
  }, 'cordis.patch.yml')
  assert.deepEqual(await profileProviders(['glm'], dir), {
    glm: { apiKeyEnv: 'PATCH_KEY', baseURL: 'https://patch.invalid', displayName: 'Base' },
    baseOnly: { apiKeyEnv: 'BASE_ONLY' }, patchOnly: { displayName: 'Patch' },
  })
})

test('显式目录缓存隔离，目录确定时 routes 不影响缓存', async () => {
  const a = writeProfile('a', { glm: { apiKeyEnv: 'KEY_A' } })
  const b = writeProfile('b', { glm: { apiKeyEnv: 'KEY_B' } })
  const first = await profileProviders(['glm'], a)
  assert.deepEqual(await profileProviders(['glm'], b), { glm: { apiKeyEnv: 'KEY_B' } })
  assert.deepEqual(await profileProviders(['glm'], a), first)
  writeProfile('a', { glm: { apiKeyEnv: 'UPDATED_A' } })
  assert.deepEqual(await profileProviders(['different-route'], a), first)
  invalidateProfileCache()
  assert.deepEqual(await profileProviders(['glm'], a), { glm: { apiKeyEnv: 'UPDATED_A' } })
})

test('扫描缓存按 routes 隔离，唯一最高分胜出且零命中为空', async () => {
  writeProfile('a', { glm: { apiKeyEnv: 'KEY_A' }, routeA: { displayName: 'A' } })
  writeProfile('b', { glm: { apiKeyEnv: 'KEY_B' }, routeB: { displayName: 'B' } })
  assert.equal((await profileProviders(['glm', 'routeA'])).glm.apiKeyEnv, 'KEY_A')
  assert.equal((await profileProviders(['glm', 'routeB'])).glm.apiKeyEnv, 'KEY_B')
  assert.deepEqual(await profileProviders(['glm']), {})
  assert.deepEqual(await profileProviders(['missing']), {})
  assert.deepEqual(await profileProviders(), {})
})

test('缺省支持 DSH_PROFILE 与 DSH_PROFILE_DIR，环境切换不复用错误缓存', async () => {
  writeProfile('a', { glm: { apiKeyEnv: 'KEY_A' } })
  const b = writeProfile('b', { glm: { apiKeyEnv: 'KEY_B' } })
  process.env.DSH_PROFILE = 'a'
  assert.equal((await profileProviders(['glm'])).glm.apiKeyEnv, 'KEY_A')
  process.env.DSH_PROFILE_DIR = b
  assert.equal((await profileProviders(['glm'])).glm.apiKeyEnv, 'KEY_B')
  delete process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE
  assert.deepEqual(await profileProviders(['glm']), {})
})

test('扫描缓存按 DSH_HOME 隔离', async () => {
  writeProfile('a', { glm: { apiKeyEnv: 'FIRST_HOME' } })
  assert.equal((await profileProviders(['glm'])).glm.apiKeyEnv, 'FIRST_HOME')
  home = path.join(root, 'other-home')
  process.env.DSH_HOME = home
  writeProfile('a', { glm: { apiKeyEnv: 'SECOND_HOME' } })
  assert.equal((await profileProviders(['glm'])).glm.apiKeyEnv, 'SECOND_HOME')
})

test('并发读取不同显式目录仍分别返回各自配置', async () => {
  const a = writeProfile('a', { glm: { apiKeyEnv: 'KEY_A' } })
  const b = writeProfile('b', { glm: { apiKeyEnv: 'KEY_B' } })
  const [first, second] = await Promise.all([profileProviders(['glm'], a), profileProviders(['glm'], b)])
  assert.equal(first.glm.apiKeyEnv, 'KEY_A')
  assert.equal(second.glm.apiKeyEnv, 'KEY_B')
})
