/**
 * 问题 2 / 问题 7 守卫（0.15.4）：客户端缺省必须与宿主同源，文案不得过度承诺。
 *
 * ## 缺陷
 *
 * 三处口径互相矛盾（`M-02`）：
 * 1. 设置页 `Config.enabled` 描述写「新会话默认回注开关」，默认 `true`；
 * 2. 宿主 `controlOf()` 以硬编码 `defaultEnabled: false` 构造 —— 新会话一律未启用；
 * 3. 客户端 `controlOfStatus()` 回落写 `enabled: true` —— chip 亮「已启用」。
 *
 * 于是：翻设置页的开关**不会让任何未启用会话开始回注**，而新会话的 chip 却显示已启用。
 * 用户看到的就是「开关没反应 + 状态在撒谎」。
 *
 * ## 用户裁定（问题 2、问题 7）
 *
 * **行为不变**——2026-10-28 的两条口径都成立且正确：
 * - 插件本身在新对话默认**关闭**（`defaultEnabled: false`）；
 * - 一旦启用，自动回注默认**开启**（`recall: true`）。
 *
 * 要改的只有「话说得不对」：
 * - 设置页描述改成「回注总闸」，说清它不影响新会话是否启用；
 * - `controlLine` 去掉「跟随全局设置页」，改为说明内置缺省 + 怎么开；
 * - 客户端回落对齐宿主：`enabled: false, recall: true`。
 *
 * ## 钉住的判据
 *
 * 1. 客户端回落 `enabled === false`（与宿主 `defaultEnabled` 同源）；
 * 2. 客户端回落 `recall === true`（一旦启用，回注默认开）；
 * 3. 设置页描述不得再出现「新会话默认回注」这种会被证伪的说法；
 * 4. `controlLine` 不得再说「跟随全局设置页」；
 * 5. 交叉核对：宿主的 `defaultEnabled` 与客户端回落必须**同时**为 false，
 *    任何一侧单独改动都会让本守卫变红。
 *
 * ## 不适用条件
 *
 * - 不测 `mergeSessionSettings` 的真值表（那是 `v3-session-control` 的职责）；
 * - 不测 UI 渲染（客户端半没有 DOM 夹具），只钉源码级判据。
 *
 * ## 变异自证
 *
 * 把客户端回落改回 `enabled: true` → 用例 1、5 红；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(here, '..', 'src', rel), 'utf8')

const client = read('client.js')
const index = read('index.mjs')
const entry = read(path.join('v3', 'entry', 'v3-entry.mjs'))

/** 取客户端 `controlOfStatus` 里 `out` 的缺省对象。 */
function clientDefault() {
  const i = client.indexOf('const out = { enabled:')
  assert.ok(i >= 0, '必须能找到客户端回落的缺省对象')
  return client.slice(i, client.indexOf('}', i) + 1)
}

test('问题 2/7：客户端回落 enabled 必须为 false（与宿主同源）', () => {
  const block = clientDefault()
  assert.ok(/enabled:\s*false/.test(block), '客户端不得再把未启用会话回落成 enabled:true，实际：' + block)
})

test('问题 2/7：客户端回落 recall 必须为 true（启用后回注默认开）', () => {
  const block = clientDefault()
  assert.ok(/recall:\s*true/.test(block), '回注缺省仍应为开，实际：' + block)
})

test('问题 2：设置页描述不得再自称「新会话默认回注开关」', () => {
  const i = index.indexOf('enabled: Schema.boolean()')
  assert.ok(i >= 0, '必须能找到设置页 enabled 字段')
  const line = index.slice(i, index.indexOf('\n', index.indexOf('.description(', i)))
  assert.ok(
    !/新会话默认回注/.test(line),
    '旧描述是过度承诺（新会话不受它控制），实际：' + line,
  )
  assert.ok(/总闸/.test(line), '应改称「回注总闸」，实际：' + line)
})

test('问题 2：controlLine 不得再说「跟随全局设置页」', () => {
  // 只看代码行，不看注释——注释里引用旧文案作为「缺陷记录」是允许的。
  const code = index
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.ok(
    !/跟随全局设置页/.test(code),
    '「跟随全局设置页」是误导（真实缺省是内置 false）',
  )
  assert.ok(/内置缺省/.test(code), '应如实说明用的是内置缺省')
  assert.ok(/memory-lab on/.test(code), '应给出启用入口')
})

test('交叉核对：宿主 defaultEnabled 与客户端回落必须同时为 false', () => {
  // 宿主侧的唯一真源
  assert.ok(
    /defaultEnabled:\s*false/.test(index),
    '宿主 controlOf 必须以 defaultEnabled:false 构造新会话（2026-10-28 裁定）',
  )
  // 客户端侧必须跟着
  assert.ok(/enabled:\s*false/.test(clientDefault()), '客户端回落必须与宿主一致')
  // 且 entry 里不得出现另一个「新会话默认开」的真源
  assert.ok(
    !/defaultEnabled:\s*true/.test(entry),
    'entry 不得再引入第二个相反的缺省真源',
  )
})
