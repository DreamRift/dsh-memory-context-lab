/**
 * P1-6 卡片降噪（0.12.0）。
 *
 * 问题：每步重复「保护集」规则、逐条重要度打分、`另有 N 条进度未展开`、
 * `已不再列出 N 行`。实测 107 张工作卡 75,011 字符、中位 466 字符/张。
 *
 * 方案（与 P0-1/P0-5 同批，必须净字节 ≤ 0）：
 * - 软保留行只报**计数**不逐条列；
 * - 「因预算丢弃」只报类别 × 段/行数，删掉逐条打分算式（算式留 status --verbose）；
 * - 固定协议文案只在**全量卡**出现；
 * - 每张增量卡硬上限（行数 + 字节），超出只留「变化摘要 + 记录 ID」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkingState,
  CARD_DELTA_MAX_CHARS,
  CARD_DELTA_MAX_LINES,
  renderWorkingSetInjection,
  workingStateCardDelta,
} from '../src/v2/working-state.mjs'

function cardOf(overrides = {}) {
  const state = buildWorkingState({
    sessionId: 'noise-test',
    surfaceNodes: [],
    eventAt: () => null,
    ...overrides,
  })
  return { state, card: renderWorkingSetInjection(state, {}) }
}

test('P1-6a 丢弃页脚只报「类别 × 段/行数」，不逐条列重要度打分算式', () => {
  // 预算压到极小 → 硬保护装不下软段，页脚必须给出丢弃报告。
  const { card } = cardOf({
    nonEssentialHistory: Array.from({ length: 4 }, (_, index) => ({
      itemId: 'h' + index,
      lines: ['历史片段 ' + index],
      source: 'history',
    })),
  })
  const small = renderWorkingSetInjection(
    buildWorkingState({ sessionId: 'noise-test', surfaceNodes: [], eventAt: () => null, nonEssentialHistory: [{ itemId: 'h', lines: ['x'], source: 'h' }] }),
    { budgetTokens: 200 },
  )
  const footer = small.text.split('\n').find((line) => line.startsWith('因预算丢弃')) ?? ''
  assert.ok(footer.length > 0, '小预算必须给出丢弃报告：' + small.text)
  assert.match(footer, /×\d+段\/\d+行/, footer)
  // 逐条打分算式（「因重要度分值 X（分量…）」）不再出现在页脚。
  assert.equal(/因重要度分值\s*[\d.]+（/.test(footer), false, '页脚不得含逐条打分算式：' + footer)
  assert.ok(card.text.length > 0)
})

test('P1-6b 软段头不再逐条重复整条类目次序（只在全量卡里保留一句）', () => {
  const { card } = cardOf({
    nonEssentialHistory: [{ itemId: 'h1', lines: ['历史片段'], source: 'history' }],
  })
  const header = card.text.split('\n').find((line) => line.startsWith('■ 软保留'))
  assert.ok(header, '必须有软段头：' + card.text)
  assert.equal(header.includes('可选预取 → 冗余卡片 → 非必要历史'), false, '类目次序不再逐条写进每张卡')
  assert.match(header, /低分先丢/)
})

test('P1-6c 增量卡有硬上限（行数 + 字节），超出只留「变化摘要 + 记录 ID」提示', () => {
  assert.ok(Number.isInteger(CARD_DELTA_MAX_LINES) && CARD_DELTA_MAX_LINES > 0)
  assert.ok(Number.isInteger(CARD_DELTA_MAX_CHARS) && CARD_DELTA_MAX_CHARS > 0)
  const previous = ['[工作状态·v2]（旧卡）', '■ 保护集·当前人类请求', '- 旧行'].join('\n')
  const nextLines = ['[工作状态·v2]（新卡）', '■ 保护集·当前人类请求', '- 旧行']
  for (let index = 0; index < 200; index += 1) nextLines.push('- 新增进度行 ' + index + ' ' + 'x'.repeat(40))
  const delta = workingStateCardDelta({ previousText: previous, nextText: nextLines.join('\n') })
  assert.ok(delta, '必须有变化')
  assert.equal(delta.truncated, true, '超长增量必须被截断并显式标记')
  assert.ok(delta.text.split('\n').length <= CARD_DELTA_MAX_LINES, '行数上限生效：' + delta.text.split('\n').length)
  // 0.13.2-beta.2（W-04）：尾行也必须计入预算，上界是**严格**的，不再留 +200 的余量。
  assert.ok(delta.text.length <= CARD_DELTA_MAX_CHARS, '字符上限生效（尾行计入预算）：' + delta.text.length)
  // 措辞在 0.13.1 更正：旧文案「完整内容以最近一张全量卡为准」是假话——模型手里的
  // 最近一张全量卡是**上一张**，它不含这些新行。现在只说「没进本卡」并指路回读，
  // 由 runtime-card 在截断时改发全量卡（见 v2-workingset-hardening 的同名用例）。
  assert.match(delta.text, /另有 \d+ 行变化未在本卡列出/, '必须如实说明还有多少行没列')
  assert.match(delta.text, /按记录 ID 回读/, '截断后必须指路回读')
})

test('P1-6d 信息不丢：被截断的行仍可按记录 ID 回读（卡片自己说明去向）', () => {
  const previous = '[工作状态·v2]（旧卡）\n- 旧行'
  const nextLines = ['[工作状态·v2]（新卡）', '- 旧行']
  for (let index = 0; index < 100; index += 1) nextLines.push('- 新行 ' + index)
  const delta = workingStateCardDelta({ previousText: previous, nextText: nextLines.join('\n') })
  assert.ok(delta.truncated)
  assert.ok(delta.text.includes('未在本卡列出'), '必须说明这些行没有进入本卡')
})
