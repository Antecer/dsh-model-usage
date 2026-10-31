import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// DSH 插件管理列表通过包根导出的 package.json 读取 name/description 作为显示回退。
// exports 若缺少该子路径，即使 description 已填写，卡片也不会显示一句话说明。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('插件管理列表可读取一句话功能描述', () => {
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.trim().length > 0, 'description 不应为空')
  assert.ok(!pkg.description.includes('\n'), '管理列表描述应保持一句话')
  assert.equal(pkg.exports['./package.json'], './package.json', '必须允许 DSH 解析包根 package.json')
})
