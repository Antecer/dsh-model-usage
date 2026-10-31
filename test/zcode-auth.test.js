import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 仅使用测试注入路径与测试密钥，不访问真实 ZCode 凭据。
const dir = mkdtempSync(path.join(tmpdir(), 'dmu-zcode-'))
const credFile = path.join(dir, 'credentials.json')
const previousCredFile = process.env.DMU_ZCODE_CRED_FILE
const previousSecret = process.env.ZCODE_CREDENTIAL_SECRET
process.env.DMU_ZCODE_CRED_FILE = credFile
process.env.ZCODE_CREDENTIAL_SECRET = 'test-secret-for-roundtrip'

const { readZcodeAppSession, saveSession, clearSession, resolveSession } = await import('../lib/zcode/auth.mjs')

const writeCreds = (creds) => writeFileSync(credFile, JSON.stringify(creds), 'utf8')
const readCreds = () => JSON.parse(readFileSync(credFile, 'utf8'))
beforeEach(() => writeCreds({}))
after(() => {
  assert.equal(path.dirname(credFile), dir)
  assert.equal(path.dirname(dir), path.resolve(tmpdir()))
  assert.ok(path.basename(dir).startsWith('dmu-zcode-'))
  rmSync(dir, { recursive: true })
  if (previousCredFile === undefined) delete process.env.DMU_ZCODE_CRED_FILE
  else process.env.DMU_ZCODE_CRED_FILE = previousCredFile
  if (previousSecret === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
  else process.env.ZCODE_CREDENTIAL_SECRET = previousSecret
})

function assertUnbound(session) {
  assert.deepEqual(session, {
    source: 'zcode', zcodeJwt: 'zcode-jwt',
    businessJwt: null, businessFamily: null, refreshToken: null,
  })
}

for (const family of ['bigmodel', 'zai']) {
  const other = family === 'bigmodel' ? 'zai' : 'bigmodel'
  test(`共享存储：${family} active 加密回读，双域凭据按当前登录选择`, async () => {
    writeCreds({
      [`oauth:${other}:access_token`]: 'other-business',
      [`oauth:${other}:refresh_token`]: 'other-refresh',
    })
    await saveSession({
      zcodeJwt: 'zcode-jwt', businessJwt: 'current-business',
      businessFamily: family, refreshToken: 'current-refresh',
    })
    const raw = readCreds()
    for (const key of ['zcodejwttoken', 'oauth:active_provider', `oauth:${family}:access_token`, `oauth:${family}:refresh_token`]) {
      assert.ok(raw[key].startsWith('enc:v1:'), `${key} 应为 enc:v1 密文`)
    }
    assert.ok(!JSON.stringify(raw).includes('current-business'), '当前业务凭据不得明文落盘')
    assert.deepEqual(await readZcodeAppSession(), {
      source: 'zcode', zcodeJwt: 'zcode-jwt', businessJwt: 'current-business',
      businessFamily: family, refreshToken: 'current-refresh',
    })
  })

  test(`共享存储：${family} 当前业务凭据缺失或损坏，不借用另一域`, async () => {
    for (const missing of [undefined, 'enc:v1:bad..payload']) {
      writeCreds({
        zcodejwttoken: 'zcode-jwt', 'oauth:active_provider': family,
        [`oauth:${family}:access_token`]: missing,
        [`oauth:${family}:refresh_token`]: 'current-refresh',
        [`oauth:${other}:access_token`]: 'other-business',
        [`oauth:${other}:refresh_token`]: 'other-refresh',
      })
      assertUnbound(await readZcodeAppSession())
    }
  })

  test(`共享存储：${family} 缺 refresh token 不借用另一域`, async () => {
    writeCreds({
      zcodejwttoken: 'zcode-jwt', 'oauth:active_provider': family,
      [`oauth:${family}:access_token`]: 'current-business',
      [`oauth:${other}:refresh_token`]: 'other-refresh',
    })
    const session = await readZcodeAppSession()
    assert.equal(session.businessFamily, family)
    assert.equal(session.refreshToken, null)
  })

  test(`兼容旧版：无 active 时只存在 ${family} 可推断`, async () => {
    writeCreds({
      zcodejwttoken: 'zcode-jwt',
      [`oauth:${family}:access_token`]: 'legacy-business',
      [`oauth:${other}:refresh_token`]: 'stale-refresh',
    })
    assert.deepEqual(await resolveSession(), {
      source: 'zcode', zcodeJwt: 'zcode-jwt', businessJwt: 'legacy-business',
      businessFamily: family, refreshToken: null,
    })
  })
}

test('无 active 且双域并存：保留赠额 JWT，不推断账户', async () => {
  writeCreds({
    zcodejwttoken: 'zcode-jwt',
    'oauth:bigmodel:access_token': 'domestic-business',
    'oauth:zai:access_token': 'international-business',
    'oauth:bigmodel:refresh_token': 'domestic-refresh',
    'oauth:zai:refresh_token': 'international-refresh',
  })
  assertUnbound(await resolveSession())
})

test('无效或无法解密的 active 不按单域凭据猜测', async () => {
  for (const active of ['', 'unknown', null, 42, 'enc:v1:bad..payload']) {
    writeCreds({
      zcodejwttoken: 'zcode-jwt', 'oauth:active_provider': active,
      'oauth:bigmodel:access_token': 'domestic-business',
      'oauth:bigmodel:refresh_token': 'domestic-refresh',
    })
    assertUnbound(await readZcodeAppSession())
  }
})

test('重新保存同域会话时移除旧 refresh token', async () => {
  await saveSession({ zcodeJwt: 'z1', businessJwt: 'b1', businessFamily: 'zai', refreshToken: 'old-refresh' })
  await saveSession({ zcodeJwt: 'z2', businessJwt: 'b2', businessFamily: 'zai' })
  assert.equal(readCreds()['oauth:zai:refresh_token'], undefined)
  assert.equal((await resolveSession()).refreshToken, null)
})

test('clearSession 清除当前域标记、两域会话与资料，保留无关凭据', async () => {
  const unrelated = {
    'bot:some-bot:credential': 'enc:v1:keepme',
    'oauth:another:user_info': 'keep-profile',
    'oauth:login_attribution': 'keep-attribution',
  }
  writeCreds({
    ...unrelated, zcodejwttoken: 'zcode-jwt', 'oauth:active_provider': 'zai',
    'oauth:bigmodel:access_token': 'domestic-business',
    'oauth:bigmodel:refresh_token': 'domestic-refresh',
    'oauth:bigmodel:user_info': 'domestic-profile',
    'oauth:zai:access_token': 'international-business',
    'oauth:zai:refresh_token': 'international-refresh',
    'oauth:zai:user_info': 'international-profile',
  })
  await saveSession({ zcodeJwt: 'z2', businessJwt: 'b2', businessFamily: 'zai' })
  for (const [key, value] of Object.entries(unrelated)) assert.equal(readCreds()[key], value)
  await clearSession()
  assert.deepEqual(readCreds(), unrelated)
  assert.equal(await resolveSession(), null)
})

test('损坏、缺 ZCode JWT 或完全无业务凭据按无会话处理', async () => {
  for (const creds of [
    { zcodejwttoken: 'enc:v1:bad..payload', 'oauth:bigmodel:access_token': 'business' },
    { 'oauth:bigmodel:access_token': 'business' },
    { zcodejwttoken: 'zcode-jwt', 'oauth:active_provider': 'zai' },
  ]) {
    writeCreds(creds)
    assert.equal(await readZcodeAppSession(), null)
  }
  writeFileSync(credFile, '{invalid json', 'utf8')
  assert.equal(await readZcodeAppSession(), null)
})
