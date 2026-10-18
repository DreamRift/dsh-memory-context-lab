/**
 * T1 / F-03：层级卡默认脱敏 + shareL2Content 开关。
 *
 * 0.11.0 之前 L1 证据卡与 L2 阶段卡的 excerpt/span-excerpt/claim 值就是成员正文
 * 摘录——默认就把正文复制进卡片。本套件钉住新契约：
 *
 * 1. 默认（shareL2Content=false）卡片只给属性 + 来源 ID + 展开入口，正文标记
 *    （CANARY）不得出现；结构化属性（exit 1、465 项全绿）照常保留；
 * 2. shareL2Content=true 才带正文摘录；
 * 3. 两种模式各自字节稳定（可做前缀缓存），切换模式才变字节；
 * 4. 模型相位的输入行同样受开关约束（建块时就脱敏，模型消息/预算/哈希与最终
 *    卡同源）；
 * 5. 崩溃重放不绕过开关：未共享正文时 L1 写占位，不把计划快照里的原文搬回账本；
 * 6. 配置默认值、面板视图字段、命令面（set sharel2content on|off）都在位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ATOM_ATTRIBUTES } from '../src/v2/evidence-atoms.mjs'
import {
  WITHHELD_EXCERPT_MARK_FOR_TEST,
  buildBlocks,
  disclosedValue,
  isFreetextAtom,
  renderEvidenceCard,
  renderPhaseCard,
  shareModeNote,
} from '../src/v2/compressor-program.mjs'
import { buildModelMessages } from '../src/v2/compressor-model.mjs'
import { initialProjectionState, BOOLEAN_SETTINGS } from '../src/core.mjs'
import { viewOf } from '../src/projection.mjs'

/** 成员正文里的唯一标记：只要卡片复制了正文，它就一定跟着出现。 */
const CANARY = 'ZEBRAFISH-CANARY-8842'

const WITHHELD = WITHHELD_EXCERPT_MARK_FOR_TEST

function excerptFact(extra = {}) {
  return {
    key: 'k-excerpt',
    entity: 'run_code',
    attribute: ATOM_ATTRIBUTES.EXCERPT,
    value: '第 3 行：' + CANARY + ' 出现在成员正文里',
    polarity: 'positive',
    relation: 'none',
    sourceRefs: [{ recordId: 'mcl2-aaa-000003', seq: 12 }],
    ...extra,
  }
}

function structuredFacts() {
  return [
    {
      key: 'k-exit',
      entity: 'run_code',
      attribute: ATOM_ATTRIBUTES.EXIT_CODE,
      value: 'exit 1',
      polarity: 'negative',
      relation: 'none',
      sourceRefs: [{ recordId: 'mcl2-aaa-000003', seq: 12 }],
    },
    {
      key: 'k-tests',
      entity: 'npm-test',
      attribute: ATOM_ATTRIBUTES.TEST_SUMMARY,
      value: '465 项全绿',
      polarity: 'positive',
      relation: 'none',
      sourceRefs: [{ recordId: 'mcl2-aaa-000004', seq: 13 }],
    },
  ]
}

test('T1 默认脱敏：卡片不含正文标记，但保留结构化属性与来源 ID', () => {
  const facts = [excerptFact(), ...structuredFacts()]
  const blocks = buildBlocks(facts, { groups: [] })
  const card = renderPhaseCard({
    summaryId: 'ph-test',
    phaseLabel: '阶段 1-8',
    memberCount: 2,
    tools: ['run_code'],
    blocks,
    manifestId: 'mf-test',
    voucherId: 'agg-test',
    modeNote: shareModeNote(false),
  })

  assert.equal(card.includes(CANARY), false, '默认卡不得复制正文：' + card)
  assert.ok(card.includes(WITHHELD), '脱敏值必须换成固定标记：' + card)
  // 结构化属性照常保留——脱敏删的是正文，不是证据。
  assert.ok(card.includes('exit 1'), '退出码必须保留：' + card)
  assert.ok(card.includes('465 项全绿'), '测试摘要必须保留：' + card)
  assert.ok(card.includes('mcl2-aaa-000003'), '来源 ID 必须保留（可展开入口）：' + card)
  assert.ok(card.includes(shareModeNote(false)), '卡里必须有一行模式说明：' + card)
})

test('T1 开关打开：卡片带正文摘录，模式说明随之改变', () => {
  const facts = [excerptFact(), ...structuredFacts()]
  const blocks = buildBlocks(facts, { groups: [] }, { shareContent: true })
  const card = renderPhaseCard({
    summaryId: 'ph-test',
    phaseLabel: '阶段 1-8',
    memberCount: 2,
    tools: ['run_code'],
    blocks,
    manifestId: 'mf-test',
    voucherId: 'agg-test',
    modeNote: shareModeNote(true),
  })
  assert.ok(card.includes(CANARY), '开启后必须带正文摘录：' + card)
  assert.equal(card.includes(WITHHELD), false, '开启后不应再有脱敏标记：' + card)
  assert.ok(card.includes(shareModeNote(true)))
  assert.notEqual(shareModeNote(true), shareModeNote(false), '模式说明必须能区分两种模式')
})

test('T1 字节稳定：同一模式两次渲染逐字节一致，切换模式才变', () => {
  const facts = [excerptFact(), ...structuredFacts()]
  const render = (shareContent) => renderPhaseCard({
    summaryId: 'ph-test',
    phaseLabel: '阶段 1-8',
    memberCount: 2,
    tools: ['run_code'],
    blocks: buildBlocks(facts, { groups: [] }, { shareContent }),
    manifestId: 'mf-test',
    voucherId: 'agg-test',
    modeNote: shareModeNote(shareContent),
  })
  assert.equal(render(false), render(false), '默认模式必须逐字节稳定')
  assert.equal(render(true), render(true), '共享模式必须逐字节稳定')
  assert.notEqual(render(false), render(true), '切换模式必须改变字节（否则开关无意义）')
})

test('T1 L1 证据卡：默认只给属性与来源，正文标记不外泄', () => {
  const atoms = [
    { entity: 'run_code', attribute: ATOM_ATTRIBUTES.SPAN_EXCERPT, value: CANARY },
    { entity: 'run_code', attribute: ATOM_ATTRIBUTES.EXIT_CODE, value: 'exit 0' },
    { entity: 'agent', attribute: ATOM_ATTRIBUTES.CLAIM, value: CANARY + ' 的结论' },
  ]
  const withheld = renderEvidenceCard({ recordId: 'mcl2-aaa-000003', spanLabel: 'seq 1-8', atoms })
  assert.equal(withheld.includes(CANARY), false, 'L1 默认不得含正文：' + withheld)
  assert.ok(withheld.includes('exit 0'), 'L1 必须保留结构化属性')
  assert.ok(withheld.includes('mcl2-aaa-000003'), 'L1 必须保留记录 ID')
  assert.ok(withheld.includes(shareModeNote(false)))

  const shared = renderEvidenceCard({ recordId: 'mcl2-aaa-000003', spanLabel: 'seq 1-8', atoms, shareContent: true })
  assert.ok(shared.includes(CANARY), 'L1 开启后带正文：' + shared)
  assert.equal(shared.includes(WITHHELD), false)
})

test('T1 自由文本判定：只有摘录/跨度摘录/结论行算正文，数值属性永不被抹', () => {
  assert.equal(isFreetextAtom({ attribute: ATOM_ATTRIBUTES.EXCERPT }), true)
  assert.equal(isFreetextAtom({ attribute: ATOM_ATTRIBUTES.SPAN_EXCERPT }), true)
  assert.equal(isFreetextAtom({ attribute: ATOM_ATTRIBUTES.CLAIM }), true)
  for (const attribute of [
    ATOM_ATTRIBUTES.EXIT_CODE,
    ATOM_ATTRIBUTES.COMMAND,
    ATOM_ATTRIBUTES.TEST_SUMMARY,
    ATOM_ATTRIBUTES.ERROR_SIGNATURE,
    ATOM_ATTRIBUTES.VERSION,
    ATOM_ATTRIBUTES.TIME,
  ]) {
    assert.equal(isFreetextAtom({ attribute }), false, attribute + ' 不是正文摘录')
    assert.equal(disclosedValue({ attribute, value: 'exit 1' }, false), 'exit 1', attribute + ' 在脱敏模式下也必须原样保留')
  }
  assert.equal(disclosedValue({ attribute: ATOM_ATTRIBUTES.EXCERPT, value: CANARY }, false), WITHHELD)
  assert.equal(disclosedValue({ attribute: ATOM_ATTRIBUTES.EXCERPT, value: CANARY }, true), CANARY)
})

test('T1 模型相位输入同样脱敏：块行里没有正文标记', () => {
  const facts = [excerptFact(), ...structuredFacts()]
  const selected = buildBlocks(facts, { groups: [] }, { shareContent: false })
  const messages = buildModelMessages({ model: 'm1', facts: [], blocks: selected, selected })
  const user = messages.find((message) => message.role === 'user')
  assert.ok(user, '必须有一条用户消息')
  assert.equal(user.content.includes(CANARY), false, '模型输入不得含成员正文：' + user.content)
  assert.ok(user.content.includes(WITHHELD), '模型看到的是固定标记')
  assert.ok(user.content.includes('exit 1'), '模型仍能看到结构化属性')

  const sharedSelected = buildBlocks(facts, { groups: [] }, { shareContent: true })
  const sharedMessages = buildModelMessages({ model: 'm1', facts: [], blocks: sharedSelected, selected: sharedSelected })
  const sharedUser = sharedMessages.find((message) => message.role === 'user')
  assert.ok(sharedUser.content.includes(CANARY), '开启后模型才看得到正文')
})

test('T1 配置与面板：默认关、视图字段在位、命令面已登记', () => {
  const state = initialProjectionState()
  assert.equal(state.shareL2Content, false, '投影初始值必须默认 false')
  const view = viewOf(state)
  assert.equal(view.shareL2Content, false, '面板视图必须带 shareL2Content 字段')
  assert.equal(viewOf({ ...state, shareL2Content: true }).shareL2Content, true)
  assert.equal(viewOf({ ...state, shareL2Content: 'yes' }).shareL2Content, false, '非布尔真值不得当作开启（失败关闭）')

  const setting = BOOLEAN_SETTINGS.sharel2content
  assert.ok(setting, 'BOOLEAN_SETTINGS 必须登记 sharel2content')
  assert.equal(setting.key, 'shareL2Content')
})

test('T1 崩溃重放不绕过开关：未共享正文时 L1 写占位，不把计划快照里的原文搬回账本', async () => {
  const { replayEntriesFromPlan } = await import('../src/v2/hierarchy-coordinator.mjs')
  const plan = {
    voucherId: 'agg-1-8-test',
    startSeq: 1,
    endSeq: 8,
    memberCount: 2,
    recordIds: ['mcl2-aaa-000003', 'mcl2-aaa-000004'],
    memberSeqs: [12, 13],
    memberTexts: [CANARY + ' 的成员原文', CANARY + ' 的第二段原文'],
    phaseCard: '【阶段卡 ph-test】阶段 1-8',
  }
  const withheld = replayEntriesFromPlan({
    plan,
    replacementSeq: 99,
    sourceRevision: 1,
    at: '2026-10-18T00:00:00.000Z',
    deps: { shareL2Content: false },
  })
  const l1 = withheld.filter((entry) => entry.kind === 'hierarchy/l1-card')
  assert.equal(l1.length, 2)
  for (const entry of l1) {
    assert.equal(entry.text.includes(CANARY), false, '重放不得把成员原文写进 L1：' + entry.text)
    assert.ok(entry.text.includes('L1 占位'), '应写占位并指路 expand/read：' + entry.text)
  }

  const shared = replayEntriesFromPlan({
    plan,
    replacementSeq: 99,
    sourceRevision: 1,
    at: '2026-10-18T00:00:00.000Z',
    deps: { shareL2Content: true },
  })
  const sharedL1 = shared.filter((entry) => entry.kind === 'hierarchy/l1-card')
  assert.ok(sharedL1.some((entry) => entry.text.includes(CANARY)), '开启后重放才带原文')
})
