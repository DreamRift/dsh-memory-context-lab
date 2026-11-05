/**
 * G6a：可追溯的确定性摘要候选（extractive-v2-candidate）——**行为对照与验收**。
 *
 * ## 缺陷（F07）
 * 现行 `summarizeRecords` 逐条取**前部** 60 码点、`summarizeRecordsStructured` 取前部 100
 * 码点：工具结果一长，**尾部更正/失败结论/最终结果**就整段消失在摘要之外；模型只看到
 * 「开头在复现」而看不到「最后失败了/被更正了」。
 *
 * ## 判据来源
 * 开发流程 §12.1（G6a 全部要求与验收）；G0 合同 C-M-01（生成器版本 extractive-v1 /
 * model-draft-v1）、C-G2-02（摘要字段只用既有集合 + 最小新增）；F07 复现输入。
 *
 * ## 断言组
 * 1. 固定合成语料对照：前部截取 vs 候选的「必须保留事实」保留率（短摘要/详细摘要分开报）。
 * 2. 语义不反转：「准备跑测试」不得变成「测试通过」；否定词不得被切断或删除。
 * 3. 来源可定位：每条片段带 source ID + 码点区间，按区间切片逐字等于正文（含星平面字符）。
 * 4. 相同输入逐字节稳定（无随机/时间/本地化依赖）。
 * 5. 边界：空文本/全空白 → 省略摘要；超长单句 → 区间平铺、不切否定词、预算有界。
 * 6. 摘要容量不挤掉回执身份/范围/来源/恢复入口（复用既有回执预算实现）。
 *
 * ## 不适用条件与已知边界
 * - 语料是**合成**的，且按 F07 故意把关键事实放在记录尾部：它只能证明「尾部丢失」这个
 *   确定缺陷被修好，**不能**证明真实任务质量提升（G8 才做真实模型对照）。
 * - 候选**默认关闭**；本套件不宣称它优于原摘要，只报来源级事实指标。
 * 运行：node --test test/v3-g6a-summary-candidate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SUMMARY_LIMITS } from '../src/v3/contracts/summaries.mjs'
import {
  CANDIDATE_GENERATOR_VERSION,
  SUMMARY_SELECTION_PRIORITY,
  summarizeRecords,
  summarizeRecordsCandidate,
  summarizeRecordsStructured,
} from '../src/v3/domain/compress/summary.mjs'
import {
  RECEIPT_MAX_CHARS,
  RECEIPT_MIN_SUMMARY_CHARS,
  RECEIPT_SUMMARY_SAFETY_MARGIN,
  renderArchiveReceipt,
} from '../src/v3/domain/archive/receipt.mjs'

/** 合成填充：与任务无关的长工具输出（把关键事实顶到记录尾部，复现 F07）。 */
const FILLER = '无关输出占位。'.repeat(20)

/**
 * 固定合成语料：目标 / 后部更正 / 最终结果 / 失败原因 / 未决事项 / 冲突表述 / 否定句。
 * 记录 ID 是合成串（v3r- + 16 hex），不含任何真实凭据。
 */
const CORPUS = Object.freeze([
  { id: 'v3r-0000000000000001', kind: 'message-user', payload: { text: '目标：修复登录接口 query 参数未透传导致 401 的问题。' } },
  { id: 'v3r-0000000000000002', kind: 'message-assistant', payload: { text: '先复现：用测试账号调用 /api/login，返回 401。' } },
  { id: 'v3r-0000000000000003', kind: 'message-assistant', payload: { text: '计划：补上参数透传，然后准备跑测试。' } },
  { id: 'v3r-0000000000000004', kind: 'message-assistant', payload: { text: '已补上 query 参数透传；准备跑测试。' } },
  { id: 'v3r-0000000000000005', kind: 'tool-result', payload: { text: FILLER + '第一轮测试结果：断言失败（期望 200，实际 401）。' } },
  { id: 'v3r-0000000000000006', kind: 'message-user', payload: { text: '更正：401 不是参数透传引起的，是 token 过期；之前那条判断作废。' } },
  { id: 'v3r-0000000000000007', kind: 'message-assistant', payload: { text: '改为刷新 token 后再登录，第一轮测试仍未通过。' } },
  { id: 'v3r-0000000000000008', kind: 'tool-result', payload: { text: FILLER + '失败原因：/api/refresh 在代理环境下超时（上游 504）。' } },
  { id: 'v3r-0000000000000009', kind: 'tool-result', payload: { text: FILLER + '最终结果：补上 token 刷新后，登录测试通过 3/3。' } },
  { id: 'v3r-0000000000000010', kind: 'message-assistant', payload: { text: '注意：测试通过不代表生产可用，发布前仍需回归。' } },
  { id: 'v3r-0000000000000011', kind: 'message-assistant', payload: { text: '未决事项：Windows 代理配置尚未验证。' } },
  { id: 'v3r-0000000000000012', kind: 'tool-result', payload: { text: FILLER + '此前记录里的「参数透传是根因」已被第 6 条更正推翻。' } },
  { id: 'v3r-0000000000000013', kind: 'message-assistant', payload: { text: '矛盾点：同一份日志说「参数已透传」，另一次复跑却显示没有透传，两处表述相反。' } },
])

/** 必须保留的来源事实：key → 出现在哪条记录、原文片段。 */
const FACTS = Object.freeze([
  { key: 'goal', recordId: 'v3r-0000000000000001', text: '修复登录接口 query 参数未透传' },
  { key: 'tail-correction', recordId: 'v3r-0000000000000006', text: '401 不是参数透传引起的，是 token 过期' },
  { key: 'superseded', recordId: 'v3r-0000000000000012', text: '已被第 6 条更正推翻' },
  { key: 'failure-conclusion', recordId: 'v3r-0000000000000005', text: '断言失败' },
  { key: 'failure-reason', recordId: 'v3r-0000000000000008', text: '上游 504' },
  { key: 'final-result', recordId: 'v3r-0000000000000009', text: '登录测试通过 3/3' },
  { key: 'open-item', recordId: 'v3r-0000000000000011', text: 'Windows 代理配置尚未验证' },
  { key: 'conflict', recordId: 'v3r-0000000000000013', text: '两处表述相反' },
])

function retainedKeys(text) {
  return FACTS.filter((fact) => text.includes(fact.text)).map((fact) => fact.key)
}

test('G6a-1 固定语料对照：候选保住尾部更正/失败结论/最终结果/未决/冲突，前部截取只保住开头', () => {
  const legacyShort = summarizeRecords(CORPUS)
  const legacyDetail = summarizeRecordsStructured(CORPUS).detail
  const candidate = summarizeRecordsCandidate(CORPUS)
  assert.equal(candidate.ok, true)
  assert.equal(candidate.generatorVersion, CANDIDATE_GENERATOR_VERSION)

  // 前部截取（现行 v1）：尾部事实进不来——这是 F07 的直接证据，也是本对照的基线口径。
  assert.deepEqual(retainedKeys(legacyShort), ['goal', 'tail-correction'])
  assert.deepEqual(retainedKeys(legacyDetail), ['goal', 'tail-correction'])
  assert.equal(legacyShort.includes('断言失败'), false, '前部切片看不到尾部失败结论')
  assert.equal(legacyShort.includes('登录测试通过 3/3'), false, '前部切片看不到尾部最终结果')

  // 候选：短摘要（预算内整段装箱）至少保住验收点名的尾部更正 / 失败结论 / 最终结果。
  const shortKeys = retainedKeys(candidate.draft.shortText)
  for (const key of ['tail-correction', 'failure-conclusion', 'failure-reason', 'final-result']) {
    assert.ok(shortKeys.includes(key), '候选短摘要必须保住 ' + key + '：' + JSON.stringify(shortKeys))
  }
  // 详细摘要：语料里 8 条必须保留事实全部在（预算 3200 足够）。
  assert.deepEqual(retainedKeys(candidate.draft.detail), FACTS.map((fact) => fact.key))

  // 必须保留的来源 span：每条事实都要被一条**码点区间**覆盖，且该区间是整段原文（可回跳）。
  const byId = new Map(CORPUS.map((record) => [record.id, [...record.payload.text]]))
  for (const fact of FACTS) {
    const chars = byId.get(fact.recordId)
    const covering = candidate.draft.sourceSpans
      .filter((span) => span.recordId === fact.recordId)
      .find((span) => chars.slice(span.start, span.end).join('').includes(fact.text))
    assert.ok(covering !== undefined, '必须保留的来源 span 未被任何片段覆盖：' + fact.key)
    const slice = chars.slice(covering.start, covering.end).join('')
    assert.ok(candidate.draft.detail.includes(slice), 'covered span 必须在详细摘要里逐字出现：' + fact.key)
  }
  // 指标如实（来源级事实保留率；不是真实任务质量）：2/8 vs 5/8（短）与 2/8 vs 8/8（详细）。
  assert.equal(shortKeys.length, 5)
  assert.ok(shortKeys.length > retainedKeys(legacyShort).length)
  assert.equal(candidate.selection.picked, candidate.selection.packedDetail + candidate.selection.omitted)
  assert.ok(candidate.selection.packedShort >= 5)
  // 候选短摘要不吃满溢出：整体仍在合同预算内。
  assert.ok([...candidate.draft.shortText].length <= SUMMARY_LIMITS.shortText)
  assert.ok([...candidate.draft.detail].length <= SUMMARY_LIMITS.detail)
})

test('G6a-2 语义不反转：「准备跑测试」不得变成「测试通过」', () => {
  // 单独一条「准备跑测试」的助手消息：候选只能逐字摘引，不能补出「通过」这一事实。
  const records = [{ id: 'v3r-aaaaaaaaaaaaaaa1', kind: 'message-assistant', payload: { text: '已补上 query 参数透传；准备跑测试。' } }]
  const candidate = summarizeRecordsCandidate(records)
  assert.equal(candidate.ok, true)
  assert.ok(candidate.draft.shortText.includes('准备跑测试'), '原文必须被完整保留：' + candidate.draft.shortText)
  assert.equal(candidate.draft.shortText.includes('测试通过'), false, '不得把「准备跑测试」写成「测试通过」')
  assert.equal(candidate.draft.detail.includes('测试通过'), false)
  // 结论字段也不许凭空升级：outcome 恒 unknown，openItems 明写结果待查。
  assert.equal(candidate.draft.outcome, 'unknown')
  assert.ok(candidate.draft.openItems.some((item) => item.includes('结果待查')))
})

test('G6a-3 否定不反转：否定词整段保留，永不出现「未」+「通过」式切断', () => {
  const records = [
    { id: 'v3r-bbbbbbbbbbbbbbb1', kind: 'message-assistant', payload: { text: '第一轮测试未通过。' } },
    { id: 'v3r-bbbbbbbbbbbbbbb2', kind: 'message-user', payload: { text: '更正：不是代理问题，而是 token 过期。' } },
    { id: 'v3r-bbbbbbbbbbbbbbb3', kind: 'message-assistant', payload: { text: '未决事项：Windows 代理配置尚未验证。' } },
  ]
  const candidate = summarizeRecordsCandidate(records)
  assert.equal(candidate.ok, true)
  for (const phrase of ['未通过', '不是代理问题', '尚未验证']) {
    assert.ok(candidate.draft.detail.includes(phrase), '否定短语必须整段保留：' + phrase)
  }
  assert.equal(candidate.draft.detail.includes('测试通过'), false, '「未通过」不得被读成「通过」')

  // 每条片段的边界都不得落在否定词内部（用来源区间自证，而不是只看渲染结果）。
  const negations = ['不通过', '未通过', '没有通过', '不是', '并非', '无法', '不能', '不得', '尚未', '并未', '未被', '不再']
  const byId = new Map(records.map((record) => [record.id, [...record.payload.text]]))
  for (const span of candidate.draft.sourceSpans) {
    const slice = byId.get(span.recordId).slice(span.start, span.end).join('')
    for (const marker of negations) {
      for (let width = 1; width < marker.length; width += 1) {
        assert.notEqual(slice.slice(-width), marker.slice(0, width), '片段不得以否定词的真前缀结尾（' + marker + '）：' + slice.slice(-width))
      }
    }
    assert.notEqual(slice.length, 0)
  }
})

test('G6a-4 来源可定位：source ID + 码点区间可逐字回跳（含星平面字符）', () => {
  const records = [
    { id: 'v3r-ccccccccccccccc1', kind: 'message-assistant', payload: { text: '😀开头：准备跑测试。' } },
    { id: 'v3r-ccccccccccccccc2', kind: 'tool-result', payload: { text: '😀'.repeat(60) + '最终结果：登录测试通过 3/3。' } },
    { id: 'v3r-ccccccccccccccc3', kind: 'message-user', payload: { text: '更正：401 不是参数透传引起的，是 token 过期。' } },
  ]
  const candidate = summarizeRecordsCandidate(records)
  assert.equal(candidate.ok, true)
  assert.ok(candidate.draft.sourceSpans.length >= 2)
  const byId = new Map(records.map((record) => [record.id, [...record.payload.text]]))
  const seen = new Set()
  for (const span of candidate.draft.sourceSpans) {
    assert.ok(byId.has(span.recordId), 'span 必须指向本摘要来源集合里的记录：' + span.recordId)
    assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start, '区间必须是有效码点范围')
    const chars = byId.get(span.recordId)
    const slice = chars.slice(span.start, span.end).join('')
    // 星平面字符必须整字取：切片里不能出现孤立代理项（按码点切分的直接证据）。
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(slice), false, '区间不得切开代理对')
    assert.equal(/[\uDC00-\uDFFF]/.test(slice.replace(/😀/g, '')), false)
    assert.ok(candidate.draft.detail.includes(slice), '详细摘要必须逐字包含该区间正文：' + slice)
    seen.add(span.recordId + '#' + span.start + '#' + span.end)
  }
  assert.equal(seen.size, candidate.draft.sourceSpans.length, 'sourceSpans 不得重复')
  // 短摘要不得另造文本：把每条片段原文抠掉后，只剩分隔符。
  const slices = [...new Set(candidate.draft.sourceSpans.map((span) => byId.get(span.recordId).slice(span.start, span.end).join('')))]
  let rest = candidate.draft.shortText
  for (const slice of slices) rest = rest.split(slice).join('')
  assert.equal(rest.replace(/；/g, ''), '', '短摘要只能由片段原文与分隔符组成：' + JSON.stringify(rest))
})

test('G6a-5 相同输入逐字节稳定：无随机、无时钟、无本地化依赖', () => {
  const first = summarizeRecordsCandidate(CORPUS)
  const second = summarizeRecordsCandidate(CORPUS.map((record) => ({ ...record, payload: { ...record.payload } })))
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同输入必须逐字节相同')
  assert.deepEqual(first.selection.priority, SUMMARY_SELECTION_PRIORITY.map((rule) => rule.category))
  assert.deepEqual(first.draft.sourceSpans, second.draft.sourceSpans)
  // 选材规则可配置且代码里只有一处默认真源：改优先级必须确定性改变选材。
  const flipped = summarizeRecordsCandidate(CORPUS, { priority: [{ category: 'goal', maxItems: 1 }, { category: 'result', maxItems: 1 }] })
  assert.equal(flipped.ok, true)
  assert.equal(flipped.draft.sourceSpans.length, 2)
  assert.equal(flipped.draft.shortText.startsWith('目标：'), true, '可配置优先级必须真的生效：' + flipped.draft.shortText)
})

test('G6a-6 边界：空文本省略摘要、超长单句不切否定、预算不足即省略', () => {
  // 空文本 / 全空白：没有可摘引片段 → 明确省略，不造假摘要，也不抛错。
  assert.deepEqual(summarizeRecordsCandidate([]), { ok: false, reason: 'no-selection', detail: '没有任何可摘引的正文片段' })
  const blank = [{ id: 'v3r-ddddddddddddddd1', kind: 'message-assistant', payload: { text: ' \n\t ' } }]
  assert.equal(summarizeRecordsCandidate(blank).ok, false)
  // 没有稳定记录 ID 的正文不进摘要（可追溯是硬要求）。
  assert.equal(summarizeRecordsCandidate([{ kind: 'message-assistant', payload: { text: '有正文但没有记录 ID。' } }]).ok, false)

  // 超长单句（无句读）：硬切但切点不得落在否定词内部。
  // 用「全类别都入选」的配置观察**完整分段**（默认优先级只选一部分，看不到整条正文的平铺）。
  const long = '甲'.repeat(118) + '未通过' + '乙'.repeat(200)
  const records = [{ id: 'v3r-eeeeeeeeeeeeeee1', kind: 'tool-result', payload: { text: long } }]
  const allCategories = SUMMARY_SELECTION_PRIORITY.map((rule) => ({ category: rule.category, order: rule.order, maxItems: 20 }))
  const seg = summarizeRecordsCandidate(records, { priority: allCategories })
  assert.equal(seg.ok, true)
  const total = [...long].length
  const slices = seg.draft.sourceSpans.slice().sort((a, b) => a.start - b.start)
  assert.equal(slices[0].start, 0, '第一段从 0 开始')
  assert.equal(slices[slices.length - 1].end, total, '最后一段到正文末尾')
  for (let index = 1; index < slices.length; index += 1) {
    assert.equal(slices[index].start, slices[index - 1].end, '区间必须首尾相接（无空洞/无重叠）')
  }
  // 否定词必须整段落在同一个片段里（切点回退到词首）。
  const negSegment = slices.find((span) => span.start <= 118 && span.end >= 121)
  assert.ok(negSegment !== undefined, '「未通过」不得被切在两个片段之间：' + JSON.stringify(slices))
  assert.equal([...long].slice(negSegment.start, negSegment.end).join('').includes('未通过'), true)

  const candidate = summarizeRecordsCandidate(records)
  assert.equal(candidate.ok, true)
  assert.ok(candidate.draft.shortText.includes('未通过'), '短摘要不得丢掉否定词：' + candidate.draft.shortText)

  // 预算放不下任何整段：省略摘要（不切段），并给出原因。
  assert.deepEqual(
    summarizeRecordsCandidate(CORPUS, { maxShortChars: 4, maxDetailChars: 4 }),
    { ok: false, reason: 'budget-too-small', detail: '预算放不下任何整段（按合同省略摘要，不切段）' },
  )

  // 大语料：条数/长度全部有界（不因输入规模放大）。
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: 'v3r-' + String(index).padStart(16, '0'),
    kind: index % 2 === 0 ? 'message-assistant' : 'tool-result',
    payload: { text: '第 ' + index + ' 条：失败原因待查。' },
  }))
  const bounded = summarizeRecordsCandidate(many)
  assert.equal(bounded.ok, true)
  assert.ok(bounded.draft.sourceSpans.length <= SUMMARY_LIMITS.items)
  assert.ok([...bounded.draft.shortText].length <= SUMMARY_LIMITS.shortText)
  assert.ok([...bounded.draft.detail].length <= SUMMARY_LIMITS.detail)
  assert.ok(bounded.draft.changes.length <= SUMMARY_LIMITS.items)
  assert.ok(bounded.draft.openItems.length <= SUMMARY_LIMITS.items)
})

test('G6a-7 摘要容量不挤掉回执身份/范围/来源/恢复入口', () => {
  const recordIds = ['v3r-0123456789abcdef', 'v3r-fedcba9876543210']
  const candidate = summarizeRecordsCandidate(CORPUS)
  const base = renderArchiveReceipt({ startSeq: 7, endSeq: 21, recordIds, operations: 2, unitLabel: '回合数' })
  const withSummary = renderArchiveReceipt({
    startSeq: 7, endSeq: 21, recordIds, operations: 2, unitLabel: '回合数',
    summary: candidate.draft.shortText,
    // P3-03：预算与净收益判据同单位（UTF-16 码元）——base.length 而不是 [...base].length。
    sourceChars: base.length + RECEIPT_SUMMARY_SAFETY_MARGIN + RECEIPT_MIN_SUMMARY_CHARS,
  })
  // 基础身份一条不少，摘要只占剩余预算。
  for (const pattern of [/已把 2 条已完成历史（seq 7–21）/, /回合数：2/, /记录 ID：v3r-0123456789abcdef/, /恢复：\/memory-lab restore/]) {
    assert.match(withSummary, pattern)
  }
  assert.ok(withSummary.length <= RECEIPT_MAX_CHARS)
  // 预算为 0 时整条省略摘要（回执与无摘要版本逐字节相同）——省略摘要不影响归档。
  const starved = renderArchiveReceipt({
    startSeq: 7, endSeq: 21, recordIds, operations: 2, unitLabel: '回合数',
    summary: candidate.draft.shortText,
    sourceChars: base.length + RECEIPT_SUMMARY_SAFETY_MARGIN,
  })
  assert.equal(starved, base)
})

test('G6a-8 呈现序（R1）：正文按时间顺序呈现，最终状态不被更早的「全部通过」覆盖', () => {
  // 审查者给的时序反例：较早的记录宣布「最终结果：全部通过」，较晚的记录宣布失败。
  const records = [
    { id: 'v3r-0000000000000001', kind: 'message-user', payload: { text: '目标：修复登录 401。' } },
    { id: 'v3r-0000000000000002', kind: 'tool-result', payload: { text: '最终结果：首轮回归全部通过 12/12。' } },
    { id: 'v3r-0000000000000003', kind: 'tool-result', payload: { text: '第二轮复跑失败：退款用例断言失败。' } },
  ]
  const candidate = summarizeRecordsCandidate(records)
  assert.equal(candidate.ok, true)
  assert.equal(candidate.selection.renderOrder, 'document')
  const short = candidate.draft.shortText
  // 选材仍按优先级（失败类别排在最前选），但**呈现**必须回到文档序。
  assert.ok(short.indexOf('目标：修复登录 401。') < short.indexOf('最终结果：首轮回归全部通过'), '正文必须按时间顺序：' + short)
  assert.ok(short.indexOf('最终结果：首轮回归全部通过') < short.indexOf('第二轮复跑失败'), '较晚的失败必须排在较早的通过之后：' + short)
  // 读者读到的**最后**一条必须是失败，而不是「全部通过」。
  const tailSegment = short.split('。').filter((part) => part.length > 0).pop()
  assert.match(tailSegment, /第二轮复跑失败/)
  assert.equal(short.trimEnd().endsWith('12/12。'), false, '不得以「全部通过」收尾')

  // 详细摘要与 sourceSpans 同序（span 顺序 = 正文顺序 = 时间顺序）。
  const detailLines = candidate.draft.detail.split('\n')
  assert.equal(detailLines.length, candidate.draft.sourceSpans.length)
  assert.match(detailLines[0], /目标：修复登录 401。/)
  assert.match(detailLines[detailLines.length - 1], /第二轮复跑失败/)
  const byId = new Map(records.map((record) => [record.id, record]))
  const ids = candidate.draft.sourceSpans.map((span) => span.recordId)
  assert.deepEqual(ids, records.map((record) => record.id), 'sourceSpans 必须按文档序')
  for (let index = 0; index < detailLines.length; index += 1) {
    const span = candidate.draft.sourceSpans[index]
    const slice = [...byId.get(span.recordId).payload.text].slice(span.start, span.end).join('')
    assert.ok(detailLines[index].includes(slice), '第 ' + index + ' 行必须对应第 ' + index + ' 条 span')
  }
  // 确定性不受影响：同输入两次逐字节相同。
  assert.equal(JSON.stringify(candidate), JSON.stringify(summarizeRecordsCandidate(records)))
})

test('G6a-9 单字否定让位（R2）：「非」不再被切成「甲乙丙非」+「常重要的」', () => {
  const text = '甲乙丙非常重要的事情，后面继续写。'
  const records = [{ id: 'v3r-0000000000000009', kind: 'tool-result', payload: { text } }]
  const allCategories = SUMMARY_SELECTION_PRIORITY.map((rule) => ({ category: rule.category, order: rule.order, maxItems: 20 }))
  const candidate = summarizeRecordsCandidate(records, { maxSegmentChars: 4, priority: allCategories })
  assert.equal(candidate.ok, true)
  const chars = [...text]
  const slices = candidate.draft.sourceSpans.map((span) => chars.slice(span.start, span.end).join(''))
  assert.equal(slices.join(''), text, '区间必须平铺整条正文')
  assert.ok(slices.includes('非常重要'), '单字否定必须随下一段（R2）：' + JSON.stringify(slices))
  assert.equal(slices.some((slice) => slice.endsWith('非')), false, '片段不得以单字否定收尾')
  assert.equal(slices.includes('甲乙丙非'), false)
})

test('G6a-10 重排后 rank 剥离：优先级装箱全进、文档序超预算才剥离', () => {
  // 真·溢出夹具（复验 2026-11-01 D7）：优先级序 [goal, result, context] 的装箱成本（用户=goal、助手=result、tool-result=context）
  // = 6+8+2 = 16（前两段以句号结尾→零分隔符），预算 16 三条**在装箱阶段全进**；
  // 文档序 [context, goal, result] 需要在甲乙后补分隔符 → 17 超预算
  // → candidateFitParagraph 按 rank 剥离 context（rank 最大），保留末尾 result。
  // packedShort(2) < picked(3) 证明剥离发生在**重排后**而非装箱跳过。
  const records = [
    { id: 'v3r-0000000000000001', kind: 'tool-result', payload: { text: '甲乙' } },
    { id: 'v3r-0000000000000002', kind: 'message-user', payload: { text: '计划：丙丁。' } },
    { id: 'v3r-0000000000000003', kind: 'message-assistant', payload: { text: '最终结果：通过。' } },
  ]
  const candidate = summarizeRecordsCandidate(records, { maxShortChars: 16, maxDetailChars: 400 })
  assert.equal(candidate.ok, true)
  const short = candidate.draft.shortText
  assert.ok([...short].length <= 16, '短摘要必须收敛在预算内：' + [...short].length + ' / ' + short)
  assert.equal(candidate.selection.picked, 3, '优先级装箱阶段三条全进')
  assert.equal(candidate.selection.packedShort, 2, '文档序 17>16 → 重排后剥离 rank 最大的 context')
  assert.equal(candidate.selection.packedDetail, 3, '详细摘要预算足够，三条都进')
  assert.ok(short.includes('计划：丙丁。'), 'goal 保留：' + short)
  assert.ok(short.includes('最终结果：通过。'), '末尾 result 不得被砍掉：' + short)
  assert.equal(short.includes('甲乙'), false, '被剥离的是 rank 最大的 context')
  assert.ok(short.indexOf('计划：丙丁。') < short.indexOf('最终结果：通过。'), '呈现仍是文档序')
})

