import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 与 ZCode 完全一致的存储：路径可由 DMU_ZCODE_CRED_FILE 注入，
// 密钥由 ZCODE_CREDENTIAL_SECRET 注入（生产为本机信息推导值）。
const dir = mkdtempSync(path.join(tmpdir(), 'dmu-zcode-'))
const credFile = path.join(dir, 'credentials.json')
process.env.DMU_ZCODE_CRED_FILE = credFile
process.env.ZCODE_CREDENTIAL_SECRET = 'test-secret-for-roundtrip'

const { readZcodeAppSession, saveSession, clearSession, resolveSession } = await import('../lib/zcode/auth.mjs')

test('共享存储：saveSession 写入 enc:v1，readZcodeAppSession 解密回读', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await saveSession({
    zcodeJwt: 'zcode-jwt-aaa',
    businessJwt: 'business-jwt-bbb',
    businessFamily: 'bigmodel',
    refreshToken: 'refresh-ccc',
  })
  // 文件格式与 ZCode 一致：enc:v1 前缀的 AES-256-GCM 密文
  const raw = JSON.parse(readFileSync(credFile, 'utf8'))
  assert.ok(raw['zcodejwttoken'].startsWith('enc:v1:'), 'zcodejwttoken 应为 enc:v1 密文')
  assert.ok(raw['oauth:bigmodel:access_token'].startsWith('enc:v1:'), '业务 JWT 应为 enc:v1 密文')
  assert.ok(!JSON.stringify(raw).includes('business-jwt-bbb'), '明文不得落盘')

  const s = await readZcodeAppSession()
  assert.equal(s.zcodeJwt, 'zcode-jwt-aaa')
  assert.equal(s.businessJwt, 'business-jwt-bbb')
  assert.equal(s.businessFamily, 'bigmodel')
  assert.equal(s.refreshToken, 'refresh-ccc')
})

test('共享存储：保留文件内其他键位；clearSession 只清会话键', async (t) => {
  await saveSession({ zcodeJwt: 'z2', businessJwt: 'b2', businessFamily: 'bigmodel' })
  const raw1 = JSON.parse(readFileSync(credFile, 'utf8'))
  raw1['bot:some-bot:credential'] = 'enc:v1:keepme'
  const { writeFileSync } = await import('node:fs')
  writeFileSync(credFile, JSON.stringify(raw1), 'utf8')

  await clearSession()
  const raw2 = JSON.parse(readFileSync(credFile, 'utf8'))
  assert.equal(raw2['bot:some-bot:credential'], 'enc:v1:keepme', '其他键位（bot 凭据）应保留')
  assert.ok(!raw2['zcodejwttoken'] && !raw2['oauth:bigmodel:access_token'], '会话键位应清除')
  assert.equal(await resolveSession(), null, '清除后无会话')
})

test('损坏/缺字段的凭据文件按无会话处理', async (t) => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(credFile, JSON.stringify({ zcodejwttoken: 'enc:v1:bad..payload' }), 'utf8')
  assert.equal(await readZcodeAppSession(), null)
})
