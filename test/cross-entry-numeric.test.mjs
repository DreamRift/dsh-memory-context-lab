/**
 * R-07/R-08（beta.9 P1-2④）：数字设置五入口的**跨入口等价性**守卫。
 *
 * 五个入口：宿主配置 schema（index.mjs，从 NUMERIC_SETTINGS 派生）、
 * normalizeSettings（core.mjs）、命令面 setSetting（parseStrictInteger + 同一
 * NUMERIC_SETTINGS 边界）、面板设置页与面板弹层（client.js 的 parseCount，
 * 浏览器 IIFE 不能 import core，靠「同一把尺子」的注释与本题维持等价）。
 *
 * 历史（R-07/R-08/W-16 台账）：设置页曾用 Number()，把 2.5/0x10/2e1 全变成
 * 合法值——一个入口偷偷放宽等于没有上限。本题把「同一非法值在所有入口得到
 * 同一结论」固化成回归：入口各自漂移时这里必红。
 *
 * ## 边界（诚实声明）
 * 面板的 DOM 渲染与点击链路不在 node 测试范围；client.js 侧按「抽出 parseCount
 * 函数体执行 + min/max 字面量比对」对照，等价性证明到判定逻辑层。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import {
  NUMERIC_SETTINGS,
  parseStrictInteger,
  boundedNumericSetting,
  normalizeSettings,
  DEFAULT_SETTINGS,
} from '../src/core.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const clientSource = () => readFile(path.join(SRC, 'client.js'), 'utf8')

/** 从 client.js 源码里抽出 parseCount 函数体，new Function 复原执行。 */
async function panelParseCount() {
  const src = await clientSource()
  const head = src.indexOf('function parseCount(text) {')
  assert.ok(head >= 0, 'client.js 必须仍有 parseCount 定义（R-08 的合并点）')
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', head); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > head, 'parseCount 函数体括号不闭合')
  const body = src.slice(src.indexOf('{', head) + 1, end)
  return new Function('text', body)
}

const PROBE_STRINGS = ['12', '0', '2.5', '0x10', '2e1', '', '   ', '-1', '1,2', '007', '12abc']
// 大数单独探针（命令面 isSafeInteger 拒、面板放行由 clampInt 兜底——已知差异，见轨B）。
const BIG_PROBE = '999999999999999999999'

test('R-07 轨A：解析尺子三入口行为等价（parseStrictInteger = bounded = normalizeSettings）', () => {
  for (const probe of PROBE_STRINGS) {
    const parsed = parseStrictInteger(probe)
    const numeric = parsed === null ? null : parsed
    // boundedNumericSetting 对「解析产物」的结论：null/越界 → undefined（回落默认）
    for (const key of Object.keys(NUMERIC_SETTINGS)) {
      const spec = NUMERIC_SETTINGS[key]
      const bounded = numeric === null ? undefined : boundedNumericSetting(numeric, spec)
      if (numeric !== null && numeric >= spec.min && numeric <= spec.max) {
        assert.equal(bounded, numeric, `解析产物 ${numeric} 在 ${key} 区间内必须被接受`)
      } else if (numeric !== null) {
        assert.equal(bounded, undefined, `解析产物 ${numeric} 在 ${key} 区间外必须被拒（不夹取）`)
      }
    }
  }
  // normalizeSettings 对越界数字回落默认，绝不夹取到边界
  const clamped = normalizeSettings({ retainOperations: 5000, archiveBatchSize: 2.5, pressureGate: -3 })
  assert.equal(clamped.retainOperations, DEFAULT_SETTINGS.retainOperations)
  assert.equal(clamped.archiveBatchSize, DEFAULT_SETTINGS.archiveBatchSize)
  assert.equal(clamped.pressureGate, DEFAULT_SETTINGS.pressureGate)
})

test('R-08 轨B：面板 parseCount 与命令面 parseStrictInteger 同尺（同一非法值同一结论）', async () => {
  const panel = await panelParseCount()
  for (const probe of PROBE_STRINGS) {
    assert.equal(
      panel(probe),
      parseStrictInteger(probe),
      `输入 ${JSON.stringify(probe)}：面板与命令面必须同结论`,
    )
  }
  // 大数（已知差异，非漂移）：parseStrictInteger 用 isSafeInteger 拒绝；面板
  // parseCount 用 isFinite+整数得 1e21，随后由 clampInt 夹到区间边界——两条入口
  // 都不产生「静默换成另一个自由值」：命令面报错，面板落边界。锁死这两条结论。
  const bigProbe = BIG_PROBE
  assert.equal(parseStrictInteger(bigProbe), null, '命令面：非 safe 整数必须拒绝')
  assert.equal(panel(bigProbe), 1e21, '面板解析：isFinite 放行（差异点，兜底在 clampInt）')
})

test('R-08 轨C：面板 min/max 字面量与 NUMERIC_SETTINGS 一致；弹层与设置页同函数', async () => {
  const src = await clientSource()
  // 区间字面量（retain 0..200、batch 1..200）必须与 core 同界
  assert.ok(src.includes('clampInt(base.retainOperations, 0, 200'), 'retain 下/上界必须 0..200')
  assert.ok(src.includes('clampInt(base.archiveBatchSize, 1, 200'), 'batch 下/上界必须 1..200')
  // parseCount 单一定义（弹层复用同一函数，不再各写一份）
  const defs = (src.match(/function parseCount\(/g) || []).length
  assert.equal(defs, 1, 'parseCount 必须只有一处定义（弹层与设置页共用），实测 ' + defs)
  for (const callSite of ['parseCount(batchDraft)', 'parseCount(pressureDraft)', 'parseCount(text)']) {
    assert.ok(src.includes(callSite), '弹层/设置页必须调用共享 parseCount：' + callSite)
  }
  // 宿主 schema 从 NUMERIC_SETTINGS 派生（R-07 的 schema 轨）
  const indexSrc = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.ok(indexSrc.includes('NUMERIC_SETTINGS'), '宿主 schema 必须从 NUMERIC_SETTINGS 派生（beta.5 的口径）')
})
