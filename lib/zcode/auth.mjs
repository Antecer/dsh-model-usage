// dsh-model-usage · ZCode 共享会话凭据（额度重置、赠额领取与模型调用）
// 存储路径与格式与 ZCode 客户端完全一致：~/.zcode/v2/credentials.json（enc:v1 AES-256-GCM，
// 密钥由本机信息推导，算法见 ZCode credentialCipherProvider）——插件与 ZCode 应用双向共用登录态：
// ZCode 登录后插件立即可用；插件内嵌登录写回同一文件，ZCode 应用同样视为已登录。
// 安全约束：凭据只在 Host 内存与该文件，不进浏览器、不写日志、不随 RPC 返回。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import path from 'node:path'

// DMU_ZCODE_CRED_FILE 仅供测试注入
const ZCODE_CRED_FILE = process.env.DMU_ZCODE_CRED_FILE || path.join(homedir(), '.zcode', 'v2', 'credentials.json')

// 会话键位（与 ZCode credentialService 一致）
const KEY_ZCODE_JWT = 'zcodejwttoken'
const KEY_ACTIVE_PROVIDER = 'oauth:active_provider'
const keyAccess = (family) => 'oauth:' + family + ':access_token'
const keyRefresh = (family) => 'oauth:' + family + ':refresh_token'

// ---------------------------------------------------------------- enc:v1 加解密（与 ZCode 同算法同密钥推导）
function cipherKey() {
  const configured = process.env.ZCODE_CREDENTIAL_SECRET
  const secret = configured || 'zcode-credential-fallback:' + platform() + ':' + homedir() + ':' + safeUsername()
  return createHash('sha256').update(secret).digest()
}
function safeUsername() {
  try { return userInfo().username } catch { return 'unknown' }
}
function decryptEncV1(value, key) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value
  const parts = value.slice(7).split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'))
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8')
  } catch { return null } // 密钥不匹配或密文损坏
}
function encryptEncV1(value, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return 'enc:v1:' + iv.toString('base64url') + '.' + cipher.getAuthTag().toString('base64url') + '.' + enc.toString('base64url')
}

// ---------------------------------------------------------------- JWT 工具
/** 解析 JWT payload.exp（秒）；非法/无 exp 返回 null。 */
export function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'))
    return Number(payload && payload.exp) || null
  } catch { return null }
}
/** 距过期秒数；无 exp 视为长期有效（返回 Infinity）。有效性最终由服务端 401 判定。 */
export function secondsUntilExpiry(token) {
  const exp = jwtExp(token)
  if (!exp) return Infinity
  return exp - Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------- 凭据文件读写
async function readCredFile() {
  try {
    const creds = JSON.parse(await readFile(ZCODE_CRED_FILE, 'utf8'))
    return creds && typeof creds === 'object' ? creds : null
  } catch { return null }
}

async function writeCredFile(creds) {
  await mkdir(path.dirname(ZCODE_CRED_FILE), { recursive: true })
  const tmp = ZCODE_CRED_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(creds, null, 2), 'utf8')
  await rename(tmp, ZCODE_CRED_FILE)
}

/** 读取并解密 ZCode 共享凭据；缺失/解密失败返回 null。 */
export async function readZcodeAppSession() {
  const creds = await readCredFile()
  if (!creds) return null
  const key = cipherKey()
  const pick = (k) => { const v = decryptEncV1(creds[k], key); return typeof v === 'string' && v ? v : null }
  const zcodeJwt = pick(KEY_ZCODE_JWT)
  const bigmodel = pick(keyAccess('bigmodel'))
  const zai = pick(keyAccess('zai'))
  if (!zcodeJwt || (!bigmodel && !zai)) return null
  const activeProvider = pick(KEY_ACTIVE_PROVIDER)
  // active provider 是 ZCode 当前登录域的事实源；损坏或歧义时不能借用另一账户。
  // 仅旧版完全未保存 active 的单域凭据允许推断，仍保留赠额使用的 ZCode JWT。
  const family = Object.hasOwn(creds, KEY_ACTIVE_PROVIDER)
    ? (activeProvider === 'bigmodel' || activeProvider === 'zai' ? activeProvider : null)
    : (Boolean(bigmodel) !== Boolean(zai) ? (bigmodel ? 'bigmodel' : 'zai') : null)
  const businessJwt = family === 'bigmodel' ? bigmodel : family === 'zai' ? zai : null
  return {
    source: 'zcode',
    zcodeJwt,
    businessJwt,
    businessFamily: businessJwt ? family : null,
    refreshToken: businessJwt ? pick(keyRefresh(family)) : null,
  }
}

/** 内嵌登录产物写回 ZCode 共享凭据文件（保留文件内其他键位）。 */
export async function saveSession(session) {
  const family = session.businessFamily || 'bigmodel'
  const key = cipherKey()
  const creds = (await readCredFile()) || {}
  creds[KEY_ZCODE_JWT] = encryptEncV1(session.zcodeJwt, key)
  creds[keyAccess(family)] = encryptEncV1(session.businessJwt, key)
  if (session.refreshToken) creds[keyRefresh(family)] = encryptEncV1(session.refreshToken, key)
  else delete creds[keyRefresh(family)]
  creds[KEY_ACTIVE_PROVIDER] = encryptEncV1(family, key)
  await writeCredFile(creds)
}

/** 断开连接：清除共享凭据中的会话键位（同时退出 ZCode 应用登录，共用会话的语义）。 */
export async function clearSession() {
  const creds = await readCredFile()
  if (!creds) return
  delete creds[KEY_ZCODE_JWT]
  delete creds[KEY_ACTIVE_PROVIDER]
  delete creds['oauth:bigmodel:user_info']
  delete creds['oauth:zai:user_info']
  delete creds[keyAccess('bigmodel')]
  delete creds[keyRefresh('bigmodel')]
  delete creds[keyAccess('zai')]
  delete creds[keyRefresh('zai')]
  await writeCredFile(creds)
}

/** 解析当前可用会话（共享存储唯一来源；有效性由服务端 401 判定）。 */
export async function resolveSession() {
  return readZcodeAppSession()
}
