/**
 * S1 evidence-atoms 接 assistant-claim 红例（0.10.1 第二批）。
 *
 * 需求（方案 §7）：现有工作状态提取对 assistant 结论覆盖不足——claim 应作为
 * 类型化原子进入事实集（与 exit-code/test-summary 同级），带 sourceRef 可回读；
 * unverified 不参与「已完成事实」的任何升级路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractAtoms, mergeFacts, ATOM_ATTRIBUTES, ATTRIBUTE_FAMILY } from '../src/v2/evidence-atoms.mjs'
import { SPAN_KINDS } from '../src/v2/history.mjs'

/** assistant.text 跨度成员（spanBodyFor 形状）。 */
function assistantMember(body, extra = {}) {
  return {
    spanKind: SPAN_KINDS.ASSISTANT_TEXT,
    scope: 'session',
    recordId: 't00000001-r0001',
    nodeId: 'mcl2-node-1',
    range: { start: 7, end: 7 },
    createdAt: '2026-10-17T00:00:00.000Z',
    body: '--- seq:7 assistant.text ---\n' + body + '\n',
    ...extra,
  }
}

test('S1-E1 assistant.text 跨度产出 CLAIM 原子：原句 + sourceRef + unverified', () => {
  const atoms = extractAtoms(assistantMember([
    '已完成：S3 折叠接线，全量 625 项 0 失败。',
    '下一步做 S1。',
  ].join('\n')))
  const claimAtoms = atoms.filter((atom) => atom.attribute === ATOM_ATTRIBUTES.CLAIM)
  assert.equal(claimAtoms.length, 1, '结论行成为 CLAIM 原子；非结论行不进')
  assert.ok(claimAtoms[0].value.includes('S3 折叠接线'), 'value 是原句')
  assert.equal(claimAtoms[0].polarity, 'positive')
  assert.equal(claimAtoms[0].verified, false, '原子级 unverified 标记')
  assert.equal(claimAtoms[0].sourceRefs[0].recordId, 't00000001-r0001')
  assert.equal(claimAtoms[0].sourceRefs[0].seq, 7)
})

test('S1-E2 反例极性透传：否定/条件 claim 原子不被 positive 淹没', () => {
  const atoms = extractAtoms(assistantMember([
    '已完成：检索修复。',
    '但尚未通过复审。',
    '如果复审通过，就提交。',
  ].join('\n')))
  const claimAtoms = atoms.filter((atom) => atom.attribute === ATOM_ATTRIBUTES.CLAIM)
  assert.equal(claimAtoms.length, 3)
  const polarities = claimAtoms.map((atom) => atom.polarity)
  assert.deepEqual(polarities, ['positive', 'negated', 'conditional'])
})

test('S1-E3 CLAIM 已登记进属性封闭集与归组家族', () => {
  assert.ok(ATOM_ATTRIBUTES.CLAIM)
  assert.ok(ATTRIBUTE_FAMILY[ATOM_ATTRIBUTES.CLAIM] === 'claim')
})

test('S1-E4 无结论行的 assistant 正文：仍走保守摘录（SPAN_EXCERPT），不产 CLAIM', () => {
  const atoms = extractAtoms(assistantMember('先看了下代码结构，基本清楚了。'))
  assert.equal(atoms.filter((atom) => atom.attribute === ATOM_ATTRIBUTES.CLAIM).length, 0)
  assert.ok(atoms.length > 0, '保守摘录兜底仍在')
  assert.equal(atoms[0].attribute, ATOM_ATTRIBUTES.SPAN_EXCERPT)
})

test('S1-E5 CLAIM 原子过 mergeFacts：同句合并来源、不同极性成冲突（不升级为事实）', () => {
  const memberA = assistantMember('已完成：检索修复。', { recordId: 't00000001-r0001' })
  const memberB = assistantMember('已完成：检索修复。', { recordId: 't00000001-r0002' })
  const atoms = [...extractAtoms(memberA), ...extractAtoms(memberB)]
  const facts = mergeFacts(atoms)
  const claimFacts = facts.filter((fact) => fact.attribute === ATOM_ATTRIBUTES.CLAIM)
  assert.equal(claimFacts.length, 1, '同句去重为一个事实')
  assert.equal(claimFacts[0].sourceRefs.length, 2, '来源引用并集')
  assert.equal(claimFacts[0].verified, false, '去重不是验证')

  // 相反极性（positive vs negated）→ conflict，绝不静默合并升级。
  const atomsConflict = [
    ...extractAtoms(assistantMember('已完成：检索修复。', { recordId: 't00000001-r0001' })),
    ...extractAtoms(assistantMember('检索修复尚未通过。', { recordId: 't00000001-r0002' })),
  ]
  const conflictFacts = mergeFacts(atomsConflict).filter((fact) => fact.attribute === ATOM_ATTRIBUTES.CLAIM)
  assert.ok(conflictFacts.some((fact) => fact.relation === 'conflict'), '极性相反的 claim 必须标 conflict')
})
