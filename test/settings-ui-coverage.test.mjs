/**
 * P2.5-T3（beta.9→beta.10）：设置面 UI 覆盖率守卫。
 *
 * 判据：src/v2/runtime-settings.mjs 的 SETTING_KEYS 闭集里每个键，在 src/client.js
 * 的 UI 上至少满足其一：① 弹层有控件；② 设置页有控件；③ 白名单（附一行理由）。
 * 背景：compress 默认开却只有命令逃生口、readlease/protect 完全无 UI（P2.5-1 实测）；
 * 0.13.1 还有「设置页白名单静默抹字段」旧案——键位缺口从此过不了门禁。
 *
 * 坏样本（M14）：revert-probe 场景 settings-ui-coverage——注释掉 compress 行断言必红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSrc = await readFile(path.join(root, 'src', 'client.js'), 'utf8')
const settingsSrc = await readFile(path.join(root, 'src', 'v2', 'runtime-settings.mjs'), 'utf8')

/** 从 SETTING_KEYS 定义行解析闭集（不 import：守卫对文本形状负责）。 */
const keysMatch = /export const SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(settingsSrc)
assert.ok(keysMatch, 'runtime-settings.mjs 的 SETTING_KEYS 定义未找到')
const SETTING_KEYS = [...keysMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])
assert.ok(SETTING_KEYS.length >= 13, 'SETTING_KEYS 解析异常：' + SETTING_KEYS.join(','))

/**
 * 每键的 UI 覆盖证据：client.js 中必须出现的形状（命令串 / 行 key / 控件字段）。
 * 新增设置键时这里**必须**补行，否则本守卫红——这正是判据。
 */
const UI_COVERAGE = {
  auto: ['/memory-lab on', '/memory-lab off'],
  recall: [], // 白名单：回注是取回闭环的一部分，恒开无开关（beta.4 口径）
  autorestore: ['自动恢复'],
  batch: ['commitBatch', "'/memory-lab set batch '"],
  retain: [], // 白名单：v1 换算保留数，命令面专属（UI 不再暴露）
  readlease: ['commitReadLease', "'/memory-lab set readlease '"],
  pressure: ['commitPressure'],
  protect: ['protectBudgetTokens'],
  fullhistory: ['全历史记忆上下文'],
  planfirst: ["'/memory-lab set planfirst '"],
  compress: ["'/memory-lab compress '", "key: 'compress'"],
  compressmodel: ["'/memory-lab set compressmodel '"],
  sharel2content: ["'/memory-lab set sharel2content '"],
}

/** 白名单：键 → 一行理由。新增条目必须写明为什么不进 UI。 */
const UI_WHITELIST = new Map([
  ['recall', '回注恒开：它是取回闭环的一部分，不是可关选项（beta.4 口径「自动回注恒开」）'],
  ['retain', 'v1 换算保留数，UI 已在 0.13.0 瘦身中删除该行，仅命令面可达'],
])

test('P2.5-T3：SETTING_KEYS 闭集每键至少一个 UI 入口或白名单', () => {
  const missing = []
  for (const key of SETTING_KEYS) {
    const patterns = UI_COVERAGE[key]
    if (!patterns) {
      missing.push(key + '（UI_COVERAGE 无条目——新增设置键必须补 UI 或白名单）')
      continue
    }
    const covered = patterns.some((p) => clientSrc.includes(p))
    if (!covered && !UI_WHITELIST.has(key)) missing.push(key + '（无任何 UI 形状：' + patterns.join(' / ') + '）')
  }
  assert.deepEqual(missing, [], '设置键 UI 缺口：\n' + missing.join('\n'))
})

test('P2.5-T3：白名单只含 SETTING_KEYS 真实存在的键', () => {
  const stale = [...UI_WHITELIST.keys()].filter((k) => !SETTING_KEYS.includes(k))
  assert.deepEqual(stale, [], '白名单引用了已不存在的设置键（请清理）：' + stale.join('、'))
})
