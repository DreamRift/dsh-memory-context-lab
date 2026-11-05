/**
 * G5 消费面复核：G3 policy 端口的两条最低修复（审查 P3-6 / P4-2）。
 *
 * - P3-6：`sanitizePolicyInput` 对**循环引用**输入抛 RangeError，与「校验失败返回
 *   {ok:false}（不抛）」的公开约定不符。消费方（G5）会把这当成"策略失败"来处理，
 *   而实际只是一个不该由异常表达的输入错误。
 * - P4-2：forbidden 的"已声明键"豁免是**按名字全局**的，导致 `usage.rows` /
 *   `components.messages.rows` 拿到的拒绝原因是「未知字段」而不是点名路径的禁令文案。
 *
 * 本套件只钉这两项（不改端口其它判据）：循环/超深输入不抛、豁免按**位置**生效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { POLICY_INPUT_PORT, sanitizePolicyInput } from '../src/v3/contracts/observation-policy-port.mjs'

const valid = () => ({
  contractVersion: 1,
  session: { id: 'sess-local-' + 'a'.repeat(16), source: 'local-diagnostic' },
  window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
  projection: {
    epoch: 1, lastPhase: 'append', lastMessageChange: 'appended',
    phaseCounts: { initial: 1, steady: 0, append: 1, 'epoch-start': 0 },
  },
  components: {
    messages: { digest: 'b'.repeat(16), count: 3, generation: 1 },
    system: { coverage: 'unobservable' },
    tools: { coverage: 'unobservable' },
  },
  usage: {
    counted: 2, duplicates: 0, late: 0, unknownArrival: 0, unsampledLegacy: 0,
    totals: { inputTokens: 10, outputTokens: 2, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    availability: { inputTokens: 'present', outputTokens: 'present', totalTokens: 'missing', cacheReadTokens: 'missing', cacheWriteTokens: 'missing', reasoningTokens: 'missing' },
    cacheReadRatio: null,
    additivity: { provider: 'deepseek', cacheFieldsAddable: true, reasoningExtraTokens: null, verified: 'source-read' },
  },
  layers: { contractVersion: 1, pluginSurface: 'partial', logicalRequest: 'not-wired', wire: 'no-seam', providerUsage: 'observed' },
})

const tamper = (mutate) => {
  const copy = valid()
  mutate(copy)
  return sanitizePolicyInput(copy)
}

test('P3-6 循环引用输入必须失败关闭（返回 {ok:false}），不得抛给消费方', () => {
  // 纯环（不含任何禁令键名）：扫描只能靠 catch 收口，正是 P3-6 的触发输入
  const pureCycle = { contractVersion: 1 }
  pureCycle.self = pureCycle
  assert.doesNotThrow(() => sanitizePolicyInput(pureCycle))
  const top = sanitizePolicyInput(pureCycle)
  assert.equal(top.ok, false)
  assert.match(top.reason, /不可扫描/)

  // 带合法字段的环：可能先撞上"按位置未声明"的禁令键名（同样失败关闭，不抛）
  const cyclic = valid()
  cyclic.self = cyclic
  assert.doesNotThrow(() => sanitizePolicyInput(cyclic))
  assert.equal(sanitizePolicyInput(cyclic).ok, false)

  const nested = valid()
  nested.usage.mirror = { back: nested.usage }
  const nestedResult = sanitizePolicyInput(nested)
  assert.equal(nestedResult.ok, false)
  assert.match(nestedResult.reason, /不可扫描/)

  const inArray = valid()
  inArray.usage.totals.cycle = [inArray.usage.totals]
  const arrayResult = sanitizePolicyInput(inArray)
  assert.equal(arrayResult.ok, false, '数组路径上的环同样要失败关闭')

  // 深到会爆栈的合法树也不许抛（同一 catch 兜住）
  const deep = valid()
  let cursor = deep
  for (let index = 0; index < 20000; index += 1) { cursor.deep = {}; cursor = cursor.deep }
  assert.doesNotThrow(() => sanitizePolicyInput(deep))
  assert.equal(sanitizePolicyInput(deep).ok, false)
})

test('P4-2 豁免按位置：window.rows 合法，usage.rows / components.messages.rows 命中禁令并点名', () => {
  // 防误杀：合法输入里本来就带 window.rows
  const ok = sanitizePolicyInput(valid())
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.input.window.rows, 2)

  const usageRows = tamper((copy) => { copy.usage.rows = [] })
  assert.equal(usageRows.ok, false)
  assert.match(usageRows.reason, /不得含逐行诊断\/正文\/凭据\/价格字段/, '必须走禁令分支（不是"未知字段"）')
  assert.match(usageRows.reason, /usage\.rows/, '必须点名命中路径')

  const messagesRows = tamper((copy) => { copy.components.messages.rows = [] })
  assert.equal(messagesRows.ok, false)
  assert.match(messagesRows.reason, /不得含逐行诊断/, '旧实现这里只说"未知字段"，P4-2 要求按位置判定')
  assert.match(messagesRows.reason, /components\.messages\.rows/)

  const topRows = tamper((copy) => { copy.rows = [] })
  assert.equal(topRows.ok, false)
  assert.match(topRows.reason, /不得含逐行诊断/, '顶层 rows 未声明在任何位置 → 必须命中禁令')
  assert.match(topRows.reason, /^.*rows$/m)

  const totalsRows = tamper((copy) => { copy.usage.totals.rows = 1 })
  assert.equal(totalsRows.ok, false)
  assert.match(totalsRows.reason, /usage\.totals\.rows/)

  // 未声明位置的 rows 在数组里同样点名路径（含下标）
  const arrayRows = tamper((copy) => { copy.usage.mirror = [{ rows: 1 }] })
  assert.equal(arrayRows.ok, false)
  assert.match(arrayRows.reason, /usage\.mirror\.\[0\]\.rows/)
})

test('P4-2 收口不放松形状校验：window.rows 位置豁免仍然只接受非负整数', () => {
  const shape = tamper((copy) => { copy.window.rows = [] })
  assert.equal(shape.ok, false)
  assert.match(shape.reason, /window\.rows 必须是非负整数/, '位置豁免后仍由字段形状校验兜住（不是放行）')
  // 端口合同对外形状不变（键集合、版本、校验器）
  assert.equal(POLICY_INPUT_PORT.version, 1)
  assert.deepEqual(Object.keys(POLICY_INPUT_PORT).sort(), ['direction', 'fields', 'forbidden', 'name', 'source', 'validate', 'version'])
  assert.equal(POLICY_INPUT_PORT.validate, sanitizePolicyInput)
})
