// dsh-model-usage · 版本更新检查
// 职责：读取本机安装的插件版本（package.json），与市场索引（GitHub Pages）
// 和 npm registry 上的最新版本比较；进程内缓存 30 分钟；任何网络或解析失败
// 都静默降级为「无更新」，绝不阻塞或影响额度快照等其他功能。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 市场索引（format 1）默认地址：本仓库 GitHub Pages 站点 */
export const DEFAULT_MARKET_URL = 'https://antecer.github.io/dsh-model-usage/index.json'
/** npm registry 默认地址（latest 标签） */
export const DEFAULT_NPM_URL = 'https://registry.npmjs.org/@antecer/dsh-model-usage/latest'
/** 检查结果进程内缓存时长（毫秒） */
const CACHE_MS = 30 * 60 * 1000
/** 单次 HTTP 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 8000

/**
 * 解析语义化版本号的前三段（忽略预发布/构建后缀）。
 * @param {unknown} v 版本字符串
 * @returns {[number, number, number] | null} 解析失败返回 null
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * 比较两个语义化版本。
 * @param {unknown} a 版本 A
 * @param {unknown} b 版本 B
 * @returns {number} a > b 返回 1，a < b 返回 -1，相等或无法比较返回 0
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/** 带超时的 GET JSON；失败（含超时/非 2xx/非法 JSON）返回 null，不抛错 */
async function getJson(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  if (timer.unref) timer.unref()
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 创建版本检查服务（每个 Host 实例一个）。
 * check() 返回 { current, latest, hasUpdate }：current 为本机安装版本，
 * latest 为市场索引与 npm 中较高的版本，hasUpdate 表示 latest > current。
 * @param {string} pkgDir 插件包根目录（读取 package.json）
 * @param {{ marketUrl?: string, npmUrl?: string }} [opts] 覆盖默认来源地址（测试用）
 */
export function createVersionService(pkgDir, opts = {}) {
  const marketUrl = opts.marketUrl || DEFAULT_MARKET_URL
  const npmUrl = opts.npmUrl || DEFAULT_NPM_URL
  let cache = null // { at, result }
  let inflight = null

  /** 本机安装的插件版本 */
  async function readLocalVersion() {
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  }

  /** 市场索引中所有插件版本里的最大值 */
  async function marketLatest() {
    const body = await getJson(marketUrl)
    if (!body || !Array.isArray(body.plugins)) return null
    let best = null
    for (const p of body.plugins) {
      for (const v of (p && p.versions) || []) {
        const ver = v && v.version
        if (typeof ver === 'string' && (!best || compareVersions(ver, best) > 0)) best = ver
      }
    }
    return best
  }

  /** npm registry latest 标签版本 */
  async function npmLatest() {
    const body = await getJson(npmUrl)
    return body && typeof body.version === 'string' ? body.version : null
  }

  async function run() {
    const [current, market, npm] = await Promise.all([readLocalVersion(), marketLatest(), npmLatest()])
    let latest = market
    if (npm && (!latest || compareVersions(npm, latest) > 0)) latest = npm
    const hasUpdate = !!(current && latest && compareVersions(latest, current) > 0)
    return { current, latest, hasUpdate }
  }

  /**
   * 检查更新：默认走 30 分钟进程内缓存；force 跳过缓存。并发调用单飞复用同一请求。
   * @param {boolean} [force] 是否强制重新检查
   */
  async function check(force) {
    const now = Date.now()
    if (!force && cache && now - cache.at < CACHE_MS) return cache.result
    if (inflight) return inflight
    inflight = run()
      .then((result) => {
        cache = { at: Date.now(), result }
        return result
      })
      .catch(() => ({ current: null, latest: null, hasUpdate: false }))
      .finally(() => { inflight = null })
    return inflight
  }

  return { check }
}
