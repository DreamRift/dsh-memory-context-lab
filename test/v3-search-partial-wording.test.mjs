/**
 * P2-17（0.15.1）：`search` 的 `completeness=partial & reason=null` → 文案指向一个不存在的「原因」。
 *
 * ## 缺陷
 * 搜索渲染在 `has_more === false && completeness !== 'complete'` 时硬写
 * 「没有更多页（但本页结果不完整，见原因）」，而「说明：<reason>」那一段只在
 * `value.reason` 存在时才打印。当 `completeness=partial` 但 `reason` 为 `null`
 * （真实存在：末页有不可读命中、但未记录具体原因）时，模型被指向一个**根本不存在**的段落，
 * 只能自己猜「是游标坏了？库坏了？还是权限？」——诚实性要求「没有原因就说没有」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-17（审读）；
 * 渲染实现见 src/v3/entry/tools.mjs 的 searchText。
 *
 * ## 修法
 * 渲染按 `reason` 是否**真的存在**分支：
 * - 有原因 → 「见下方说明」（并且下面确实会打印说明）；
 * - 无原因 → 明说「本次未给出具体原因」，不再制造不存在的指引。
 *
 * ## 断言组
 * 1. partial + reason=null + has_more=false → 文案**不得**出现「见原因」/「见下方说明」，
 *    必须明说「未给出具体原因」；
 * 2. partial + reason 存在 → 正常打印说明，且指向是有效的；
 * 3. complete + has_more=false → 仍写「已查全」（不误伤）；
 * 4. 空结果 + partial 无原因 → 不得写「原因见上」。
 *
 * ## 不适用条件与已知边界
 * - 只改**文案**，不改 completeness/reason 的取值与判定。
 * - 上游是否真的会产生 reason=null 的 partial，由 provider 决定；本条只保证渲染不撒谎。
 *
 * ## 定点变异自证
 * 文案退回无条件「见原因」→ 组 1/4 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryContextTools } from '../src/v3/entry/tools.mjs'
import { MEMORY_CONTEXT_TOOL_NAMES } from '../src/v3/contracts/tools.mjs'

function renderSearch(value) {
  const tools = createMemoryContextTools({ engine: {} })
  const definition = tools.find((row) => row.name === MEMORY_CONTEXT_TOOL_NAMES.search)
  assert.ok(definition !== undefined)
  return definition.output.render({}, value)[0].text
}

const base = {
  status: 'ok',
  scope: 'records',
  returned_count: 0,
  total_match_count: 3,
  completeness: 'partial',
  reason: null,
  has_more: false,
  skipped_count: 2,
  next_cursor: null,
  items: [],
  error: null,
}

test('P2-17 partial 且无原因：不得指向不存在的「原因」', () => {
  const text = renderSearch({ ...base })
  assert.equal(/见原因/.test(text), false, '不得写「见原因」——后面根本没有原因段：' + text)
  assert.equal(/见下方说明/.test(text), false, '不得写「见下方说明」')
  assert.match(text, /未给出具体原因/, '必须明说没有给出原因（诚实）')
})

test('P2-17 partial 且有原因：说明段落必须真的存在', () => {
  const text = renderSearch({ ...base, reason: 'cursor-invalid' })
  assert.match(text, /说明：cursor-invalid/, '有原因时必须打印说明')
  assert.equal(/未给出具体原因/.test(text), false, '有原因时不得说自己没给')
})

test('P2-17 complete 且没有更多页：仍写「已查全」（不误伤）', () => {
  const text = renderSearch({ ...base, completeness: 'complete', reason: null, skipped_count: 0 })
  assert.match(text, /已查全/)
})

test('P2-17 空结果 + partial 无原因：不得写「原因见上」', () => {
  const text = renderSearch({ ...base })
  assert.equal(/原因见上/.test(text), false, '没有原因段时不得写「原因见上」：' + text)
})
