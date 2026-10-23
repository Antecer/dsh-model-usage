// dsh-model-usage · 内嵌 ZCode 登录（重置功能的兜底会话来源）
// 流程：打开 bigmodel.cn/login 授权 → 浏览器跳转 zcode:// 回调（会被 ZCode 应用截获，
// 用户手动复制回调链接）→ 粘贴到插件 → zcode.z.ai 兑换 zcode JWT + 业务 JWT。
// 注意：appId=zcode 是 GLM 给 ZCode 注册的 OAuth 客户端，此处为灰度借用。
import { randomUUID } from 'node:crypto'

export const ZCODE_CLIENT_ID = 'zcode'
export const ZCODE_REDIRECT = 'zcode://oauth/callback'
export const ZCODE_TOKEN_URL = 'https://zcode.z.ai/api/v1/oauth/token'

export function newLoginState() {
  return randomUUID()
}

export function buildAuthorizeUrl(state) {
  return 'https://bigmodel.cn/login?redirect=' + encodeURIComponent(ZCODE_REDIRECT)
    + '&appId=' + ZCODE_CLIENT_ID + '&state=' + encodeURIComponent(state)
}

/** 解析用户粘贴的回调链接（zcode://oauth/callback?code=...&state=...）或裸授权码。 */
export function parseCallbackInput(input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (!s.includes('://')) return { code: s, state: null }
  try {
    const u = new URL(s)
    const code = u.searchParams.get('code') || u.searchParams.get('authCode')
    if (!code) return null
    return { code, state: u.searchParams.get('state') }
  } catch { return null }
}

/** 授权码兑换：一次换回 zcode JWT + BigModel 业务 JWT。state 必须与签发一致。 */
export async function exchangeCode({ code, state }, fetchImpl = fetch) {
  const res = await fetchImpl(ZCODE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ provider: 'bigmodel', code, redirect_uri: ZCODE_REDIRECT, state: state || '' }),
  })
  const data = await res.json().catch(() => null)
  if (!data || (data.code !== undefined && data.code !== 0 && data.code !== null)) {
    throw new Error('授权码兑换失败' + (data && data.msg ? '：' + data.msg : ''))
  }
  const d = data.data || {}
  const bm = d.bigmodel || {}
  const zcodeJwt = String(d.token || '').trim()
  const businessJwt = String(bm.access_token || bm.accessToken || '').trim()
  if (!zcodeJwt || !businessJwt) throw new Error('兑换响应缺少 token（授权码可能已使用或过期）')
  return {
    zcodeJwt,
    businessJwt,
    businessFamily: 'bigmodel',
    refreshToken: bm.refresh_token || bm.refreshToken || null,
  }
}
