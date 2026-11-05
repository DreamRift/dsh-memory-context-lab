/**
 * G4 回执合同（离线子集）：外置回执必须让模型**能看懂、能读回、能判断未展示范围**。
 *
 * ## 这一套证明什么（开发流程 §10）
 * - 用途摘要、稳定来源 ID（来源事件 + 记录 ID + 幂等 ID）、明确未展示范围（码点区间 + 省略字数）、
 *   **能实际分页的 memory_context_read 入口**都在回执里，且同一输入逐字节确定；
 * - 两种哈希分别命名（surface-content-hash / record-text-hash）且不互相顶替；脱敏改变长度时
 *   如实标「可能已脱敏」，字数按**记录正文**算；
 * - 分页计划与读侧同源：单页上界来自 contracts/readback.mjs 的同一常量，页数/末页长度可算；
 * - 回读入口的参数名与既有 READ 工具 schema 一致（不新增工具、不自造参数）；
 * - 回执上界有界（首 + 尾 + 固定行），且不再承诺「逐字/精确原文」。
 *
 * ## 这一套不证明什么
 * 真实模型是否会去回读、wire 层是否只看到回执，均未验（G8）。本套件只锁「回执内容与分页语义」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIRST_INGRESS_DEFAULTS,
  FIRST_INGRESS_TOKEN,
  charCountOf,
  contentHashOf,
  externalIdOf,
  pagingOf,
  previewBlocksOf,
  readEntryLinesOf,
  surfaceStateOf,
  textOfBlocks,
} from '../src/v3/domain/first-ingress/preview.mjs'
import {
  FIRST_INGRESS_HASH_KINDS,
  FIRST_INGRESS_ID_PREFIX,
  FIRST_INGRESS_POLICY_VERSION,
  FIRST_INGRESS_READ_PAGE_CHARS,
  FIRST_INGRESS_THRESHOLD_CHARS,
  READBACK_MAX_CHARS,
  READBACK_OFFSET_UNIT,
} from '../src/v3/contracts/readback.mjs'
import { MEMORY_CONTEXT_TOOL_NAMES, READ_TOOL_PARAMETERS } from '../src/v3/contracts/tools.mjs'
import { V3ContractViolation } from '../src/v3/contracts/errors.mjs'

const BIG = 'A'.repeat(9000)
const RECORD = 'v3r-' + 'ab'.repeat(8)
const SOURCE = 'dsh-3'

/** 回执参数（幂等 ID 走同一份实现，不在测试里另写派生）。 */
function args(overrides = {}) {
  const content = overrides.content ?? [{ type: 'text', text: BIG }]
  const surfaceContentHash = overrides.surfaceContentHash ?? contentHashOf(content)
  return {
    content,
    handle: overrides.handle ?? RECORD,
    surfaceContentHash,
    sourceEventId: overrides.sourceEventId ?? SOURCE,
    externalId: overrides.externalId ?? externalIdOf({ sessionKey: 's-g4', sourceEventId: overrides.sourceEventId ?? SOURCE, surfaceContentHash }),
    recordTextHash: overrides.recordTextHash ?? contentHashOf([{ type: 'text', text: textOfBlocks(content) }]),
    toolName: overrides.toolName ?? null,
    callId: overrides.callId ?? null,
    isError: overrides.isError ?? false,
    exactCopy: overrides.exactCopy ?? null,
    config: overrides.config ?? {},
  }
}

test('G4-R1 回执五要素齐全且逐字节确定（用途/来源身份/未展示范围/可分页回读入口）', () => {
  const a = previewBlocksOf(args({ toolName: 'Bash', callId: 'c1', exactCopy: true }))
  const b = previewBlocksOf(args({ toolName: 'Bash', callId: 'c1', exactCopy: true }))
  assert.deepEqual(a, b, '同一输入必须逐字节相同（确定性）')
  const text = textOfBlocks(a)
  assert.ok(text.includes(FIRST_INGRESS_TOKEN), '幂等标记')
  assert.ok(text.includes('用途摘要：'), '用途摘要')
  assert.ok(text.includes('来源身份：来源事件 ' + SOURCE), '稳定来源 ID（来源事件）')
  assert.ok(text.includes('记录 ' + RECORD), '稳定来源 ID（记录）')
  assert.ok(/幂等 ID fi-[0-9a-f]{16}/.test(text), '幂等 ID')
  assert.ok(text.includes('未展示范围：码点 600–8800'), '明确未展示范围（码点区间）')
  assert.ok(text.includes('（省略 8200 字）'), '明示省略字数')
  assert.ok(text.includes(MEMORY_CONTEXT_TOOL_NAMES.read), '只指向既有读工具')
  assert.equal(/memory_context_(?!read)/.test(text), false, '不得印其它工具名（工具集恒定）')
})

test('G4-R2 两种哈希分别命名且不互换：脱敏改变长度时如实标注、字数按记录正文', () => {
  const original = [{ type: 'text', text: 'H'.repeat(9000) }]
  const stored = 'X'.repeat(3000) // 脱敏后长度变了
  const surfaceContentHash = contentHashOf(original)
  const recordTextHash = contentHashOf([{ type: 'text', text: stored }])
  assert.notEqual(surfaceContentHash, recordTextHash, '两种 hash 不同义')
  const text = textOfBlocks(previewBlocksOf({
    content: [{ type: 'text', text: stored }],
    handle: RECORD,
    surfaceContentHash,
    recordTextHash,
    sourceEventId: SOURCE,
    externalId: externalIdOf({ sessionKey: 's-g4', sourceEventId: SOURCE, surfaceContentHash }),
    exactCopy: false,
  }))
  assert.ok(text.includes(FIRST_INGRESS_HASH_KINDS.surface + '=' + surfaceContentHash), '原文 hash 用自己的名字')
  assert.ok(text.includes(FIRST_INGRESS_HASH_KINDS.record + '=' + recordTextHash), '副本 hash 用自己的名字')
  assert.ok(text.includes('共 3000 字'), '体量按记录正文算（不是宿主原文）')
  assert.ok(text.includes('content hash 不一致'), '脱敏必须如实标注')
  assert.ok(text.includes('不得当作宿主原文'))
})

test('G4-R3 幂等 ID 的维度：会话/来源事件/原文 hash/策略版本任一变化都产生新身份', () => {
  const surfaceContentHash = contentHashOf([{ type: 'text', text: BIG }])
  const base = externalIdOf({ sessionKey: 's-a', sourceEventId: SOURCE, surfaceContentHash, policyVersion: FIRST_INGRESS_POLICY_VERSION })
  assert.ok(base.startsWith(FIRST_INGRESS_ID_PREFIX))
  assert.equal(/^fi-[0-9a-f]{16}$/.test(base), true, '形态固定（fi-<16 位小写十六进制>）')
  assert.equal(externalIdOf({ sessionKey: 's-a', sourceEventId: SOURCE, surfaceContentHash, policyVersion: FIRST_INGRESS_POLICY_VERSION }), base, '同维度稳定')
  assert.notEqual(externalIdOf({ sessionKey: 's-b', sourceEventId: SOURCE, surfaceContentHash }), base, '会话进维度（跨会话不复用身份）')
  assert.notEqual(externalIdOf({ sessionKey: 's-a', sourceEventId: 'dsh-4', surfaceContentHash }), base, '来源事件进维度')
  assert.notEqual(externalIdOf({ sessionKey: 's-a', sourceEventId: SOURCE, surfaceContentHash: '0'.repeat(16) }), base, '原文 hash 进维度')
  assert.notEqual(externalIdOf({ sessionKey: 's-a', sourceEventId: SOURCE, surfaceContentHash, policyVersion: FIRST_INGRESS_POLICY_VERSION + 1 }), base, '策略版本进维度')
  assert.throws(() => externalIdOf({}), V3ContractViolation)
  assert.throws(() => externalIdOf({ sessionKey: 's-a', sourceEventId: SOURCE, surfaceContentHash: 'XYZ' }), V3ContractViolation)
})

test('G4-R4 分页计划：页数与末页长度按码点算，页上界与读侧同一真源', () => {
  const page = FIRST_INGRESS_READ_PAGE_CHARS
  assert.equal(page, READBACK_MAX_CHARS, '页上界必须与 READBACK_MAX_CHARS 同源')
  const cases = [
    { total: 0, pages: 0, last: 0 },
    { total: 1, pages: 1, last: 1 },
    { total: page, pages: 1, last: page },
    { total: page + 1, pages: 2, last: 1 },
    { total: page * 3, pages: 3, last: page },
  ]
  for (const row of cases) {
    const text = 'x'.repeat(row.total)
    const paging = pagingOf(text)
    assert.equal(paging.total, row.total)
    assert.equal(paging.pages, row.pages, '总页数：' + row.total)
    assert.equal(paging.lastPageChars, row.last, '末页长度：' + row.total)
  }
  // 码点口径：增补平面字符按 1 码点算（不是 UTF-16 单元）
  const emoji = '😀'.repeat(10)
  assert.equal(pagingOf(emoji).total, 10)
})

test('G4-R5 回读入口参数名与既有 READ 工具 schema 一致（不自造新工具/参数）', () => {
  const props = READ_TOOL_PARAMETERS.properties
  for (const key of ['id', 'offset', 'length', 'cursor']) {
    assert.ok(Object.hasOwn(props, key), '参数 ' + key + ' 必须在既有 READ schema 里')
  }
  const paging = pagingOf(BIG)
  const text = readEntryLinesOf({
    recordId: RECORD,
    sourceEventId: SOURCE,
    externalId: externalIdOf({ sessionKey: 's-g4', sourceEventId: SOURCE, surfaceContentHash: contentHashOf([{ type: 'text', text: BIG }]) }),
    text: BIG,
    surfaceContentHash: contentHashOf([{ type: 'text', text: BIG }]),
    recordTextHash: contentHashOf([{ type: 'text', text: BIG }]),
  }).join('\n')
  assert.ok(text.includes(JSON.stringify({ id: RECORD, offset: 0, length: paging.pageChars })), '第一页调用形态可直接执行')
  assert.ok(text.includes('偏移单位 ' + READBACK_OFFSET_UNIT), '单位如实写出')
  assert.ok(text.includes('共 ' + paging.pages + ' 页'), '页数如实写出')
  assert.ok(text.includes('next_cursor'), '续读给出真实协议（不是「再读一次」）')
  assert.ok(text.includes('命令面 /memory-lab read 是另一条通道'), '命令面例外必须如实提示')
  assert.equal(/逐字可回读|精确原文/.test(text), false, '不得承诺命令面做不到的事')
})

test('G4-R6 回执上界有界：正文只留首尾 + 固定行，省略部分不进回执', () => {
  const text = textOfBlocks(previewBlocksOf(args()))
  const head = FIRST_INGRESS_DEFAULTS.headChars
  const tail = FIRST_INGRESS_DEFAULTS.tailChars
  assert.ok(text.length < head + tail + 1200, '回执必须远小于原文（实际 ' + text.length + '）')
  assert.ok(text.includes('A'.repeat(head)), '首段保留')
  assert.ok(text.includes('A'.repeat(tail)), '尾段保留')
  assert.equal(text.includes('A'.repeat(head + 1) + 'A'.repeat(tail)), false, '中段不得整段出现')
  assert.ok(charCountOf(text) < charCountOf(BIG), '回执必须比正文短（收益前提）')
  // 小文本：全部保留（没有省略段）
  const small = 'B'.repeat(400)
  const smallText = textOfBlocks(previewBlocksOf(args({
    content: [{ type: 'text', text: small }],
    surfaceContentHash: contentHashOf([{ type: 'text', text: small }]),
  })))
  assert.ok(smallText.includes('省略 0 字'), '没有省略时也必须如实写 0（不留歧义）')
})

test('G4-R7 缺必需要素一律拒绝（来源 ID / 幂等 ID / 原文 hash / 记录 ID / 空正文）', () => {
  const base = args()
  assert.throws(() => previewBlocksOf({ ...base, handle: 'seq:12' }), V3ContractViolation)
  assert.throws(() => previewBlocksOf({ ...base, sourceEventId: '' }), V3ContractViolation)
  assert.throws(() => previewBlocksOf({ ...base, externalId: 'fi-XYZ' }), V3ContractViolation)
  assert.throws(() => previewBlocksOf({ ...base, surfaceContentHash: 'nope' }), V3ContractViolation)
  assert.throws(() => previewBlocksOf({ ...base, content: [] }), V3ContractViolation)
  assert.throws(() => previewBlocksOf({ ...base, content: [{ type: 'text', text: '' }] }), V3ContractViolation)
})

test('G4-R8 阈值与页上界都从合同派生（不在候选里另写数字）', () => {
  assert.equal(FIRST_INGRESS_THRESHOLD_CHARS, Math.floor(READBACK_MAX_CHARS * 0.75))
  assert.ok(FIRST_INGRESS_THRESHOLD_CHARS < READBACK_MAX_CHARS, '阈值必须严格小于回读上限')
  // 超阈值但很短的回执才外置：回执不比正文短时由用例层拒绝（not-worth，见状态机套件）
  assert.equal(pagingOf(BIG).pageChars, READBACK_MAX_CHARS)
})


test('G4-R9 表层状态判据：原文/本机制回执/别人的回执/被改写，四态分开（对账的唯一判据）', () => {
  const content = [{ type: 'text', text: BIG }]
  const surfaceContentHash = contentHashOf(content)
  assert.equal(surfaceStateOf({ content, expectedSurfaceHash: surfaceContentHash }), 'original')
  assert.equal(surfaceStateOf({ content, expectedSurfaceHash: '0'.repeat(16) }), 'diverged')
  assert.equal(surfaceStateOf({ content, expectedSurfaceHash: null }), 'unknown', '没有可比 hash 时不猜')
  const mine = 'fi-' + 'ab'.repeat(8)
  const other = 'fi-' + 'cd'.repeat(8)
  const preview = [{ type: 'text', text: FIRST_INGRESS_TOKEN + ' 幂等 ID ' + mine + ' 正文' }]
  assert.equal(surfaceStateOf({ content: preview, externalId: mine }), 'externalized', '本次幂等 ID 命中才算已外置')
  assert.equal(surfaceStateOf({ content: preview, externalId: other }), 'externalized-other', '别人的回执不得认领')
  assert.equal(surfaceStateOf({ content: preview, externalId: null }), 'externalized-other')
  assert.equal(surfaceStateOf({ content: null }), 'diverged')
})