// DSH profile 配置探测：从本机 profile 的 cordis.patch.yml 读取 pi-ai 供应商的
// baseURL / apiKeyEnv / displayName，让 sub2api 中继无需在插件里重复配置参数。
// 只读操作；解析器是面向该固定结构的缩进栈扫描器（避免引入 YAML 依赖）。
//
// 注意：DSH_PROFILE / DSH_PROFILE_DIR 只由 dsh-shell-env 注入到工具子进程，
// 插件 Host 进程里并没有。因此缺省时扫描全部 profile，按当前 llm 路由命中数
// 自动识别正在运行的 profile。
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
}

/** 显式指定的 profile 目录（环境变量存在时优先）。 */
function explicitProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  if (process.env.DSH_PROFILE) return join(dshHome(), 'profiles', process.env.DSH_PROFILE)
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

/** 读取单个 profile 目录的供应商表（patch 优先，cordis.yml 兜底合并）。 */
async function readProfileProviders(dir) {
  const out = {}
  for (const file of ['cordis.patch.yml', 'cordis.yml']) {
    try {
      const found = scanProviders(await readFile(join(dir, file), 'utf8'))
      for (const [id, v] of Object.entries(found)) out[id] = { ...(out[id] || {}), ...v }
    } catch { /* 文件不存在或不可读时忽略 */ }
  }
  return out
}

/** 无环境变量时，按当前 llm 路由在 providers 中的命中数识别正在运行的 profile。 */
async function detectProfileProviders(routes) {
  const base = join(dshHome(), 'profiles')
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
  }
  return best || {}
}

let cache = null
let cacheAt = 0

/** 读取当前运行 profile 的供应商端点信息；60 秒缓存。routes 用于无环境变量时识别 profile。 */
export async function profileProviders(routes) {
  const now = Date.now()
  if (cache && now - cacheAt < 60000) return cache
  const dir = explicitProfileDir()
  cache = dir ? await readProfileProviders(dir) : await detectProfileProviders(routes)
  cacheAt = now
  return cache
}

/** 供应商配置变更后失效缓存。 */
export function invalidateProfileCache() {
  cache = null
  cacheAt = 0
}
