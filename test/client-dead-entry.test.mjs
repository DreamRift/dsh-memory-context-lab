/**
 * 0.13.1 守卫：删除功能后不得留下死入口。
 *
 * ## 缺陷（本轮实测发现）
 * 0.13.1 删掉了预设功能（Config schema 不再有 `presets`，命令面不再有 `preset`），
 * 但面板与设置页仍留着两处入口：
 * 1. 会话面板的预设下拉框 —— 选一次就发 `/memory-lab preset …`，得到帮助文本；
 * 2. 设置页的「新增预设」编辑器 —— 点保存会把 `path: ['presets']` 写进 Config，
 *    而 schema 里没有这个字段，用户只会看到一次失败。
 * 同类问题还有：面板「清理」按钮发的 `clean` 当时没有实现（见 panel-command-coverage）、
 * 以及一批已无引用的 i18n 键与重复键。
 *
 * ## 判据
 * - `client.js` 不得再出现 `presets` 作为**数据面**（Config 读写 / 视图读取）；
 * - i18n 的 zh / en 两本字典键集合必须完全相等；
 * - 字典里不得有重复键（后者会静默覆盖前者）；
 * - 字典里不得有既没被 `t('…')` 直接引用、也不在间接映射表里的键。
 *
 * ## 不适用条件与已知边界
 * 这是文本守卫：它不渲染面板，也不证明 UI 视觉正确。间接引用（错误码 → 键名的
 * 映射表）必须登记在 `INDIRECT_KEYS` 里，否则会被误报成死键。
 *
 * ## 运行
 * `node --test-force-exit test/client-dead-entry.test.mjs`；有问题退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 通过映射表间接引用的键（错误码 → i18n 键）。 */
const INDIRECT_KEYS = new Set(['error.noRemote', 'error.unknownCommand', 'output.empty'])

async function clientSource() {
  return readFile(path.join(SRC, 'client.js'), 'utf8')
}

function dictOf(source, name) {
  const start = source.indexOf('var ' + name + ' = {');
  assert.ok(start >= 0, name + ' 字典找不到')
  const end = source.indexOf('};', start)
  assert.ok(end > start, name + ' 字典没有闭合')
  const body = source.slice(start, end)
  const keys = [...body.matchAll(/'([A-Za-z.]+)':/g)].map((m) => m[1])
  return { body, keys }
}

test('量具自检：两本字典都读到了', async () => {
  const source = await clientSource()
  const zh = dictOf(source, 'zh')
  const en = dictOf(source, 'en')
  assert.ok(zh.keys.length > 20, 'zh 字典过小（' + zh.keys.length + '），扫描器可能失效')
  assert.ok(en.keys.length > 20, 'en 字典过小（' + en.keys.length + '），扫描器可能失效')
})

test('预设删除后不得留下 Config 数据面引用', async () => {
  const source = await clientSource()
  const dataplane = []
  if (/path: \['presets'\]/.test(source)) dataplane.push("写 Config 的 path: ['presets']")
  if (/source\.presets/.test(source)) dataplane.push('读取 source.presets')
  if (/current\.presets|prev\.presets|server\.presets/.test(source)) dataplane.push('草稿里的 presets 字段')
  assert.deepEqual(dataplane, [], '预设已从 schema 删除，这些引用会让保存失败：' + dataplane.join(' / '))
})

test('zh / en 两本字典的键集合必须完全相等', async () => {
  const source = await clientSource()
  const zh = new Set(dictOf(source, 'zh').keys)
  const en = new Set(dictOf(source, 'en').keys)
  const onlyZh = [...zh].filter((k) => !en.has(k)).sort()
  const onlyEn = [...en].filter((k) => !zh.has(k)).sort()
  assert.deepEqual(onlyZh, [], 'zh 有而 en 没有：' + onlyZh.join(' / '))
  assert.deepEqual(onlyEn, [], 'en 有而 zh 没有：' + onlyEn.join(' / '))
})

test('字典里不得有重复键（后者会静默覆盖前者）', async () => {
  const source = await clientSource()
  const problems = []
  for (const name of ['zh', 'en']) {
    const { keys } = dictOf(source, name)
    const seen = new Set()
    for (const k of keys) {
      if (seen.has(k)) problems.push(name + ': ' + k)
      seen.add(k)
    }
  }
  assert.deepEqual([...new Set(problems)], [], '重复的 i18n 键：' + [...new Set(problems)].join(' / '))
})

test('字典里不得有死键（既没直接引用也不在间接映射表里）', async () => {
  const source = await clientSource()
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z.]+)'/g)].map((m) => m[1]))
  const { keys } = dictOf(source, 'zh')
  const dead = keys.filter((k) => !used.has(k) && !INDIRECT_KEYS.has(k)).sort()
  assert.deepEqual(dead, [], '没有任何引用的 i18n 键（删功能后留下的）：' + dead.join(' / '))
})
