// DSH profile 配置探测：从本机 profile 的 cordis.patch.yml 读取 pi-ai 供应商的
// baseURL / apiKeyEnv / displayName，让 sub2api 中继无需在插件里重复配置参数。
// 只读操作；解析器是面向该固定结构的缩进栈扫描器（避免引入 YAML 依赖）。
//
// 注意：DSH_PROFILE / DSH_PROFILE_DIR 只由 dsh-shell-env 注入到工具子进程，
// 插件 Host 应传入当前 profile 目录；无目录或环境变量时才扫描全部 profile，
// 按当前 llm 路由命中数识别，最高分并列则不推断。
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
}

/** Host 显式目录优先；未提供时保留环境变量兼容。 */
function explicitProfileDir(profileDir) {
  if (typeof profileDir === 'string' && profileDir.trim()) return resolve(profileDir.trim())
  if (process.env.DSH_PROFILE_DIR?.trim()) return resolve(process.env.DSH_PROFILE_DIR.trim())
  if (process.env.DSH_PROFILE?.trim()) return resolve(dshHome(), 'profiles', process.env.DSH_PROFILE.trim())
  return null
}

/** 扫描 YAML 文本，提取 providers.<id> 下的 { baseURL, apiKeyEnv, displayName }。 */
function scanProviders(text) {
  const out = {}
  const stack = [] // [{ indent, key }]，只记录映射节点
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const m = /^([\w.@+-]+):\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const key = m[1]
    let value = (m[2] || '').trim()
    const hash = value.indexOf(' #')
    if (hash >= 0) value = value.slice(0, hash).trim()
    value = value.replace(/^["']|["']$/g, '')
    if (value === '') { stack.push({ indent, key }); continue }
    // 叶子行：只关心 providers 块内的属性
    const provIdx = stack.findIndex((s) => s.key === 'providers')
    if (provIdx < 0 || stack.length < provIdx + 2) continue
    const id = stack[provIdx + 1].key
    if (key === 'baseURL' || key === 'apiKeyEnv' || key === 'displayName') {
      ;(out[id] || (out[id] = {}))[key] = value
    }
  }
  return out
}

/** 先读取基础配置，再用 patch 覆盖同路由字段。 */
async function readProfileProviders(dir) {
  const out = {}
  for (const file of ['cordis.yml', 'cordis.patch.yml']) {
    try {
      const found = scanProviders(await readFile(join(dir, file), 'utf8'))
      for (const [id, v] of Object.entries(found)) out[id] = { ...(out[id] || {}), ...v }
    } catch { /* 文件不存在或不可读时忽略 */ }
  }
  return out
}

/** 无环境变量时，按当前 llm 路由在 providers 中的命中数识别正在运行的 profile。 */
async function detectProfileProviders(routes, base) {
  let names = []
  try {
    names = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return {} }
  let best = null
  let bestScore = 0
  for (const name of names) {
    const providers = await readProfileProviders(join(base, name))
    if (!Object.keys(providers).length) continue
    const score = (routes || []).filter((r) => providers[r]).length
    if (score > bestScore) { best = providers; bestScore = score }
    // 同名路由可能分属不同账户；最高分并列时不能按目录遍历顺序选择凭据来源。
    else if (score === bestScore && score > 0) best = null
  }
  return best || {}
}

let cache = null

/** 读取当前 profile 供应商信息；显式目录优先，按来源隔离 60 秒缓存。 */
export async function profileProviders(routes, profileDir) {
  const dir = explicitProfileDir(profileDir)
  const base = resolve(dshHome(), 'profiles')
  const routeIds = [...new Set((routes || []).filter((route) => typeof route === 'string'))].sort()
  const key = JSON.stringify(dir ? ['directory', dir] : ['scan', base, routeIds])
  const now = Date.now()
  if (cache?.key === key && now - cache.at < 60000) return cache.providers
  const providers = dir ? await readProfileProviders(dir) : await detectProfileProviders(routeIds, base)
  cache = { key, providers, at: now }
  return providers
}

/** 供应商配置变更后失效缓存。 */
export function invalidateProfileCache() {
  cache = null
}
