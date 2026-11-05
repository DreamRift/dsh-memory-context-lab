import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildWarmSummaryReference } from '../src/v3/domain/compress/warm/summary-reference.mjs'

const sessionKey = 'session-a'
const id1 = 'v3r-0123456789abcdef'
const id2 = 'v3r-1123456789abcdef'
function node(seq, text, recordId = id1, session = sessionKey) {
  return { seq, eventId: 'host-event-' + seq, text, recordId, sessionKey: session }
}
function candidate(overrides = {}) {
  return { startSeq: 1, endSeq: 2, sourceEventSeqs: [1, 2], recordIds: [id1, id2], sessionKey, ...overrides }
}
function input(overrides = {}) {
  return { sessionKey, activeSurfaceNodes: [node(1, '不是 X；'), node(2, '更正为 Y。', id2)], archiveCandidate: candidate(), summaryBudgetCodePoints: 240, ...overrides }
}

test('§7.1 与 §8.1：重复调用得到深相等的稳定 IR', () => {
  const value = input()
  assert.deepEqual(buildWarmSummaryReference(value), buildWarmSummaryReference(value))
})

test('§7.2、§8.2：摘要片段全是输入原文连续子串，不添加结论', () => {
  const value = input({ activeSurfaceNodes: [node(1, '事实甲。事实乙！事实丙？')], archiveCandidate: candidate({ endSeq: 1, sourceEventSeqs: [1], recordIds: [id1] }) })
  const result = buildWarmSummaryReference(value)
  assert.equal(result.shortText, '事实甲。事实乙！事实丙？')
  for (const sentence of ['事实甲。', '事实乙！', '事实丙？']) assert.ok(value.activeSurfaceNodes[0].text.includes(sentence))
  assert.ok(!result.shortText.includes('事实丁'))
})

test('§7.3：候选缺少来源身份时不能生成 complete 摘要', () => {
  const value = input({ archiveCandidate: candidate({ recordIds: [] }) })
  assert.equal(buildWarmSummaryReference(value).status, 'rejected')
})

test('§7.4、§8.13：输出 schema 排除 usage、命中率、收益、cursor、时间和前缀', () => {
  const result = buildWarmSummaryReference(input())
  const keys = Object.keys(result)
  for (const forbidden of ['usage', 'cacheHit', 'hitRate', '收益', 'cursor', 'timestamp', 'randomId', 'prefix', 'R0', 'R1', 'R2', 'relation', 'predicate']) assert.ok(!keys.includes(forbidden))
})

test('§7.5、§8.3：预算截断保留否定/更正顺序并标 partial', () => {
  const result = buildWarmSummaryReference(input({ summaryBudgetCodePoints: 5 }))
  assert.equal(result.status, 'partial')
  assert.equal(result.capped, true)
  assert.ok(result.shortText.includes('不是 X；'))
  assert.ok(result.sources.includes(id1) && result.sources.includes(id2))
})

test('§7.6、§8.4：引用只逐字复制候选 record ID，不以 seq 冒名', () => {
  const result = buildWarmSummaryReference(input())
  assert.deepEqual(result.sources, [id1, id2])
  assert.ok(!result.sources.includes('1'))
})

test('§7.7、§8.7：不签发 cursor；截断只有 partial 状态和 capped 属性', () => {
  const result = buildWarmSummaryReference(input({ summaryBudgetCodePoints: 1 }))
  assert.equal(result.status, 'partial')
  assert.equal(result.capped, true)
  assert.equal(Object.hasOwn(result, 'cursor'), false)
})

test('§7.8、§8.8：跨 session 节点冲突拒绝且不泄载荷', () => {
  const result = buildWarmSummaryReference(input({ activeSurfaceNodes: [node(1, '秘密正文', id1, 'foreign'), node(2, '私密', id2)] }))
  assert.equal(result.status, 'conflict')
  assert.equal(Object.hasOwn(result, 'shortText'), false)
})

test('§7.9、§8.10：额外存储/宿主/模型端口均被封闭 schema 拒绝', () => {
  for (const key of ['fs', 'store', 'host', 'model', 'MCP']) {
    const value = { ...input(), [key]: {} }
    assert.equal(buildWarmSummaryReference(value).status, 'rejected')
  }
})

test('§7.10、§8.12：IR 不含随机/时间字段与前缀组装指令', () => {
  const result = buildWarmSummaryReference(input())
  assert.deepEqual(Object.keys(result), ['status', 'capped', 'shortText', 'detail', 'evidenceRefs', 'sources', 'omittedRefs', 'omittedAfterSeq'])
})

test('§7.11、§8.5：谓词或关系输入按封闭模型拒绝', () => {
  assert.equal(buildWarmSummaryReference({ ...input(), predicate: 'source' }).status, 'rejected')
  assert.equal(buildWarmSummaryReference(input({ archiveCandidate: { ...candidate(), relation: 'source' } })).status, 'rejected')
})

test('§7.12、§8.9：未知输入字段与伪版本拒绝', () => {
  assert.equal(buildWarmSummaryReference({ ...input(), version: 'v999' }).status, 'rejected')
  assert.equal(buildWarmSummaryReference(input({ activeSurfaceNodes: [{ ...node(1, '正文'), schemaVersion: 9 }, node(2, '更正', id2)] })).status, 'rejected')
})

test('§8.1：摘要完全重算且无对象键插入顺序依赖', () => {
  const first = input()
  const reordered = { summaryBudgetCodePoints: 240, archiveCandidate: candidate(), activeSurfaceNodes: [node(1, '不是 X；'), node(2, '更正为 Y。', id2)], sessionKey }
  assert.deepEqual(buildWarmSummaryReference(first), buildWarmSummaryReference(reordered))
})

test('§8.2、§8.3：句子保留码点原文和否定更正，预算不足 partial', () => {
  const original = '不是🙂X；更正为 Y。'
  const result = buildWarmSummaryReference(input({ activeSurfaceNodes: [node(1, original)], archiveCandidate: candidate({ endSeq: 1, sourceEventSeqs: [1], recordIds: [id1] }), summaryBudgetCodePoints: 5 }))
  assert.ok(original.includes(result.shortText))
  assert.equal(result.status, 'partial')
})

test('§8.4：合法记录 ID 保持原值；仅有 seq 无法合成 record ID', () => {
  assert.deepEqual(buildWarmSummaryReference(input()).sources, [id1, id2])
  const noIds = buildWarmSummaryReference(input({ activeSurfaceNodes: [node(1, '正文', null)], archiveCandidate: candidate({ endSeq: 1, sourceEventSeqs: [1], recordIds: [id1] }) }))
  assert.equal(noIds.status, 'unavailable')
})

test('§8.5：输入谓词字段 rejected，不尝试关系映射', () => {
  assert.equal(buildWarmSummaryReference({ ...input(), predicate: { arbitrary: true } }).status, 'rejected')
})

test('§8.6：零/超 P2 短摘要预算被码点上限约束，基础身份不被裁', () => {
  const zero = buildWarmSummaryReference(input({ summaryBudgetCodePoints: 0 }))
  assert.equal(zero.status, 'partial')
  const capped = buildWarmSummaryReference(input({ activeSurfaceNodes: [node(1, '🙂'.repeat(250))], archiveCandidate: candidate({ endSeq: 1, sourceEventSeqs: [1], recordIds: [id1] }), summaryBudgetCodePoints: 999 }))
  assert.equal([...capped.shortText].length, 0)
  assert.deepEqual(capped.sources, [id1])
  assert.equal(capped.status, 'partial')
})

test('§8.7：来源数组保留完整身份，截断仅标 capped 属性与 partial', () => {
  const result = buildWarmSummaryReference(input({ summaryBudgetCodePoints: 1 }))
  assert.equal(result.capped, true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.sources, [id1, id2])
})

test('§8.7：201 个有效引用有界截断并报告 omittedRefs', () => {
  const ids = Array.from({ length: 201 }, (_, index) => 'v3r-' + index.toString(16).padStart(16, '0'))
  const nodes = ids.map((id, index) => node(index + 1, '', id))
  const result = buildWarmSummaryReference(input({
    activeSurfaceNodes: nodes,
    archiveCandidate: { startSeq: 1, endSeq: 201, sourceEventSeqs: nodes.map((entry) => entry.seq), recordIds: ids, sessionKey },
  }))
  assert.equal(result.sources.length, 200)
  assert.equal(result.capped, true)
  assert.equal(result.status, 'partial')
  assert.equal(result.omittedRefs, 1)
  assert.deepEqual(result.sources, ids.slice(0, 200))
})

test('§8.8：默认 session 内容只限同会话，归属不符拒绝', () => {
  assert.equal(buildWarmSummaryReference(input({ archiveCandidate: candidate({ sessionKey: 'foreign' }) })).status, 'conflict')
})

test('§8.9：ActiveNode 與候選未知字段拒绝', () => {
  assert.equal(buildWarmSummaryReference(input({ activeSurfaceNodes: [{ ...node(1, '正文'), mystery: true }, node(2, 'Y', id2)] })).status, 'rejected')
})

test('§8.10、§8.12：静态检查纯 domain 无外部端口/接线依赖', () => {
  const source = readFileSync(new URL('../src/v3/domain/compress/warm/summary-reference.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:fs|node:net|fetch\s*\(|from ['"].*application|from ['"].*composition|from ['"].*entry/iu)
})

test('§8.11：候选中段来源缺口不伪装完整 ok', () => {
  const value = input({ activeSurfaceNodes: [node(1, '前文。'), node(3, '后文。', id2)], archiveCandidate: candidate({ endSeq: 3, sourceEventSeqs: [1, 2, 3] }) })
  assert.equal(buildWarmSummaryReference(value).status, 'unavailable')
})

test('§8.13：P2 身份原样保留且不增公共状态/字段', () => {
  const result = buildWarmSummaryReference(input())
  assert.deepEqual(result.sources, [id1, id2])
  assert.ok(['ok', 'partial'].includes(result.status))
})

// 删除关键校验的变异守卫：三项分别锁住未知字段、会话隔离和 record 身份映射；删掉任一实现检查即失败。
test('变异守卫：未知字段、跨会话与伪造记录身份校验必须存在', () => {
  assert.equal(buildWarmSummaryReference({ ...input(), injected: true }).status, 'rejected')
  assert.equal(buildWarmSummaryReference(input({ activeSurfaceNodes: [node(1, '私密', id1, 'elsewhere'), node(2, '内容', id2)] })).status, 'conflict')
  assert.equal(buildWarmSummaryReference(input({ archiveCandidate: candidate({ recordIds: ['v3r-0000000000000000'] }) })).status, 'unavailable')
})

// 变异守卫：节点 ID 合法，仅候选 ID 非法，锁定候选格式校验而非映射错误。
test('变异守卫：P2 record ID 格式校验单独生效', () => {
  const malformedId = 'NOT-A-RECORD-ID'
  const validId = id1
  const result = buildWarmSummaryReference(input({
    activeSurfaceNodes: [node(1, '正文', validId)],
    archiveCandidate: candidate({ endSeq: 1, sourceEventSeqs: [1], recordIds: [malformedId] }),
  }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'recordIds 含非法 P2 record ID')
})

// §8.12 的 SummaryArtifact/version 字段不在 §3.1 输入模型中；不发明字段，只验证输入顶层未知版本被拒绝。
test('输入模型未定义 SummaryArtifact：不接受附加 artifact 槽', () => {
  assert.equal(buildWarmSummaryReference({ ...input(), summaryArtifact: { schemaVersion: 1, unknown: true } }).status, 'rejected')
})
