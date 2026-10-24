// dsh-model-usage · 市场索引构建脚本（CI 部署前运行）
// 目标：site/index.json 不再入库——完全由「静态元数据 + git tag」生成到部署产物中。
// 规则：
//   1) 静态展示字段取自 scripts/market-meta.mjs；
//   2) 版本条目从 git tag（v*）读取：版本号取该 tag 的 package.json，commit 取 tag 指向的提交，
//      publishTimestamp 取 tag 首次出现的提交时间，engines 取该 tag 的 package.json；
//   3) 工作区 package.json 的版本若尚无 tag（发版提交尚未打 tag 的兜底），用 GITHUB_SHA / HEAD 追加；
//   4) 按 SemVer 从新到旧排序，写入 site/index.json（生成产物，已加入 .gitignore，不提交）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKET_META } from './market-meta.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = join(ROOT, 'site', 'index.json')
const PKG_PATH = join(ROOT, 'package.json')
const REPO_URL = 'https://github.com/Antecer/dsh-model-usage'

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const tryGit = (args) => {
  try { return git(args) } catch { return null }
}
const commitOf = (ref) => tryGit(['rev-parse', ref])
const timeOf = (ref) => {
  const t = tryGit(['log', '-1', '--format=%ct', ref])
  return t ? Number(t) : null
}
const manifestAt = (ref) => {
  const raw = tryGit(['show', ref + ':package.json'])
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** SemVer 三段比较：返回 -1 表示 a 更新（用于从新到旧排序） */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0)
  const pb = String(b).split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return -1
    if (pa[i] < pb[i]) return 1
  }
  return 0
}

const fallbackEngines = (MARKET_META.plugins[0] && MARKET_META.plugins[0].engines) || {}

/** 从 tag 读取版本条目 */
const entries = new Map()
const tags = (tryGit(['tag', '--list', 'v*']) || '').split('\n').filter(Boolean)
for (const tag of tags) {
  const manifest = manifestAt(tag)
  const commit = commitOf(tag)
  if (!manifest || !manifest.version || !commit) continue
  entries.set(manifest.version, {
    version: manifest.version,
    publishTimestamp: timeOf(tag) || Math.floor(Date.now() / 1000),
    source: { type: 'git', url: REPO_URL, commit },
    engines: manifest.engines || fallbackEngines,
  })
}

/** 兜底：工作区版本尚未打 tag 时用本次提交 */
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
const headCommit = process.env.GITHUB_SHA || commitOf('HEAD')
if (pkg.version && headCommit && !entries.has(pkg.version)) {
  entries.set(pkg.version, {
    version: pkg.version,
    publishTimestamp: Math.floor(Date.now() / 1000),
    source: { type: 'git', url: REPO_URL, commit: headCommit },
    engines: pkg.engines || fallbackEngines,
  })
}

const versions = [...entries.values()].sort((a, b) => compareVersions(a.version, b.version))
if (versions.length === 0) {
  console.error('build-index: 没有可用版本（需要 git tag 或 package.json 版本）')
  process.exit(1)
}

const index = {
  format: MARKET_META.format,
  title: MARKET_META.title,
  description: MARKET_META.description,
  plugins: MARKET_META.plugins.map((plugin) => ({ ...plugin, versions })),
}
writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log('build-index: ' + versions.map((v) => v.version).join(', '))
