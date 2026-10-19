/**
 * 0.13.1 守卫：设置键位必须「折叠得进、命令写得动」。
 *
 * ## 缺陷
 * 投影折叠（core.mjs 的 foldCommandIntoState）认 NUMERIC_SETTINGS 与
 * BOOLEAN_SETTINGS 里的**全部**键名，而 v2 命令面 setSetting 只有自己那一串
 * 手写 if 分支。两边是**两份独立清单**，删 v1 命令面时 `protect` 掉了一边：
 * 面板与日志折叠显示「保护预算已改」，实际敲 /memory-lab set protect 8192 只回
 * 「未知设置项」——运行时的保护预算永远是配置默认值 32768。
 *
 * 反过来也会坏：SETTING_KEYS 里列了键、setSetting 却没有对应分支，命令会一路
 * 落到最后的错误分支（用户看到「未知设置项」，而提示里明明有这个键）。
 *
 * ## 判据
 * - NUMERIC_SETTINGS ∪ BOOLEAN_SETTINGS 的键名 ⊆ SETTING_KEYS；
 * - SETTING_KEYS 的每个键在 setSetting 里都有 `key === '<键>'` 分支；
 * - 每个键的**取值域**与 core 的区间一致（数字键的上下界出现在对应分支里）。
 *
 * ## 不适用条件与已知边界
 * 文本分析：证明「清单与分支对得上」，不证明校验逻辑正确（例如把 < 写成 <=）。
 * 数字区间的比对只查上下界字面量是否出现，不解析表达式。
 *
 * ## 运行
 * node --test-force-exit test/settings-key-coverage.test.mjs；有缺口退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NUMERIC_SETTINGS, BOOLEAN_SETTINGS } from '../src/core.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const settingsSource = () => readFile(path.join(SRC, 'v2', 'runtime-settings.mjs'), 'utf8')

function settingKeys(source) {
  const head = 'export const SETTING_KEYS = Object.freeze(['
  const start = source.indexOf(head)
  const end = source.indexOf('])', start)
  const m = start >= 0 && end > start ? [null, source.slice(start + head.length, end)] : null
  assert.ok(m, 'runtime-settings.mjs 必须仍有 SETTING_KEYS 字面量（本守卫依赖该形态）')
  return [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1])
}

test('量具自检：两份清单都读到了', async () => {
  const keys = settingKeys(await settingsSource())
  assert.ok(keys.length >= 12, 'SETTING_KEYS 只解析出 ' + keys.length + ' 个键')
  assert.ok(Object.keys(NUMERIC_SETTINGS).length >= 5)
  assert.ok(Object.keys(BOOLEAN_SETTINGS).length >= 6)
})

test('折叠认得的每个键，命令面都必须能写', async () => {
  const keys = new Set(settingKeys(await settingsSource()))
  const folded = [...Object.keys(NUMERIC_SETTINGS), ...Object.keys(BOOLEAN_SETTINGS)]
  const missing = folded.filter((k) => !keys.has(k))
  assert.deepEqual(missing, [],
    'core 折叠认这些键，setSetting 却写不了（面板/日志显示改成功、命令报未知设置项）：' + missing.join(','))
})

test('SETTING_KEYS 的每个键都有对应分支', async () => {
  const source = await settingsSource()
  const branches = new Set([...source.matchAll(/key === '([a-z0-9]+)'/g)].map((m) => m[1]))
  const missing = settingKeys(source).filter((k) => !branches.has(k))
  assert.deepEqual(missing, [], 'SETTING_KEYS 列了但没有分支（命令会落到错误分支）：' + missing.join(','))
})

test('数字键的取值域与 core 的 NUMERIC_SETTINGS 一致', async () => {
  const source = await settingsSource()
  const problems = []
  for (const [name, spec] of Object.entries(NUMERIC_SETTINGS)) {
    const idx = source.indexOf("key === '" + name + "'")
    if (idx < 0) continue
    const next = source.indexOf("} else if (key ===", idx)
    const block = source.slice(idx, next < 0 ? undefined : next)
    const min = String(spec.min).replace(/_/g, '')
    const max = String(spec.max).replace(/_/g, '')
    const normalize = (text) => text.replace(/_/g, '')
    // 上界可以写死字面量，也可以从 core 的同一份 spec 派生（更强：不会漂移）。
    const derived = block.includes('NUMERIC_SETTINGS[') && block.includes('].max')
    if (!normalize(block).includes('< ' + min) && spec.min !== 0) problems.push(name + ' 下界 ' + min + ' 未出现在分支里')
    if (!derived && !normalize(block).includes(max)) problems.push(name + ' 上界 ' + max + ' 未出现在分支里，也没有从 NUMERIC_SETTINGS 派生')
  }
  assert.deepEqual(problems, [], '数字键的校验区间与 core 不一致：' + problems.join('；'))
})
