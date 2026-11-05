/**
 * P7 首次呈现候选（默认关闭）——选点/水位 + 受限端口 + 确定性预览 + 失败回退 + 严格配对。
 *
 * ## 这一套证明什么
 * - 源码合同层：pre-step 内改写「当前活动面上的单个 tool/result、仅 message.content」
 *   后，下一次 deriveMessages 就是预览版（同一机制宿主 pruner 在生产里使用）；
 * - 选点：最新优先、只处理本次新出现（水位）且未预览过的结果，每步受 maxPerStep 限制；
 *   已先以全文呈现过的结果默认不改写，显式改写时单独记账（presentedThenArchived）；
 * - 失败关闭：hash 过期、类型不符、非纯文本、持久化/回读失败，一律不改面；
 *   水位缺失 / 未闭合配对 → 整轮不动作；
 * - P2-1：append 之后复核失败 = 已改写但确认失败（独立状态，不宣称原文仍在）；
 * - P2-2：端口被拒时绝不降级成 user/message replace；
 * - P2-3：带来源标记的回读结果不会二次外置；
 * - P2-4：预览保留工具身份/错误态/体量/句柄/截断标识；
 * - P1-1：阈值与 read 上限同源（由同一常量派生），句柄不再承诺「逐字/精确原文」。
 *
 * ## 这一套不证明什么（待授权验证项）
 * - 真实 runtime 排序：宿主 compaction/pruner 与插件 hook 的注册先后、pre-step 是否
 *   真的总在 buildRequest 之前（源码顺序 ≠ 运行时保证）；
 * - 下一请求观察：逻辑请求（llm/stream）里是否真的只出现预览、wire 层是否另有原文；
 * - 非 agent-loop 请求（压缩摘要、会话标题）是否会把该结果先带入模型。
 * 这三项都只能在用户授权的专用会话里验；端口未接入任何入口（见 default-off 套件）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FakeSession, SurfaceError } from './helpers/fake-host.mjs'
import { createDshHostAdapter } from '../src/v3/adapters/host/dsh-host.mjs'
import {
  FIRST_INGRESS_DEFAULTS,
  FIRST_INGRESS_TOKEN,
  contentHashOf,
  externalIdOf,
  isPreviewContent,
  pagingOf,
  previewBlocksOf,
  readEntryLinesOf,
  shouldExternalize,
  surfaceStateOf,
  textOfBlocks,
} from '../src/v3/domain/first-ingress/preview.mjs'
import { FIRST_INGRESS_THRESHOLD_CHARS, READBACK_MAX_CHARS } from '../src/v3/contracts/readback.mjs'
import { V3ContractViolation } from '../src/v3/contracts/errors.mjs'
import { runFirstIngressPreview } from '../src/v3/application/first-ingress.mjs'

const BIG = 'A'.repeat(9000)
const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * G4：回执现在强制带「稳定来源 ID + 幂等 ID + 宿主原文 hash」，单元测试统一从这里取，
 * 不再各写一份常量（幂等 ID 的派生必须是同一份实现）。
 */
const PREVIEW_SOURCE = 'dsh-3'
function previewArgs({ content, handle, toolName = null, callId = null, isError = false, exactCopy = null, config = {}, sessionKey = 'p7-session' }) {
  const surfaceContentHash = contentHashOf(content)
  return {
    content,
    handle,
    surfaceContentHash,
    sourceEventId: PREVIEW_SOURCE,
    externalId: externalIdOf({ sessionKey, sourceEventId: PREVIEW_SOURCE, surfaceContentHash }),
    recordTextHash: contentHashOf([{ type: 'text', text: textOfBlocks(content) }]),
    toolName,
    callId,
    isError,
    exactCopy,
    config,
  }
}

function appendOp(session, { callId = 'c1', text = BIG, isError = false, toolName = 'read', messageSource } = {}) {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'm-' + callId, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }], source: { kind: 'model' } },
  }, { surfaceOp: 'append' })
  const result = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'r-' + callId,
      role: 'tool',
      content: [{ type: 'text', text }],
      source: messageSource ?? { kind: 'tool', callId },
      toolCallId: callId,
      isError,
    },
  }, { surfaceOp: 'append' })
  return result.seq
}

/** 基准会话：系统 + 用户消息已经入过请求，水位停在它们之后；结果事件是「本次新出现」。 */
function sessionWithResult(text = BIG, { isError = false, id = 'p7-session' } = {}) {
  const session = new FakeSession({ id })
  session.append('system/message', {
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
  const resultSeq = appendOp(session, { callId: 'c1', text, isError })
  return { session, resultSeq, state }
}

function fakeStore({ storedText = BIG, surfaceHashMatched = true } = {}) {
  const rows = new Map()
  const calls = { persist: 0, read: 0, lastPersist: null }
  let next = 0
  return {
    rows,
    calls,
    // 真实适配器只返回「已保存（可能脱敏）的正文」；这里显式建模这一点。
    async persistOriginal(args) {
      calls.persist += 1
      calls.lastPersist = args
      next += 1
      const recordId = 'v3r-' + String(next).padStart(16, '0')
      rows.set(recordId, storedText)
      return { recordId, text: storedText, surfaceHashMatched, surfaceEventId: 'dsh-' + args.seq }
    },
    async readOriginal(recordId) {
      calls.read += 1
      return { text: rows.get(recordId) }
    },
  }
}

test('P7-1 预览确定性：同输入两次逐字节相同，含标记/句柄/省略计数/工具身份/截断标识', () => {
  const content = [{ type: 'text', text: BIG }]
  const opts = previewArgs({ content, handle: 'v3r-0000000000000001', toolName: 'Bash', callId: 'c1', isError: false, exactCopy: true })
  const a = previewBlocksOf(opts)
  const b = previewBlocksOf(opts)
  assert.deepEqual(a, b)
  const text = textOfBlocks(a)
  assert.ok(text.includes(FIRST_INGRESS_TOKEN))
  // G4：回执指向**能分页的工具面**（命令面是没有分页的另一条通道，只做如实提示）。
  assert.ok(text.includes('memory_context_read ' + JSON.stringify({ id: 'v3r-0000000000000001', offset: 0, length: READBACK_MAX_CHARS })), text.slice(0, 400))
  assert.ok(text.includes('命令面 /memory-lab read 是另一条通道'))
  assert.ok(text.includes('省略'))
  assert.ok(Array.from(text).length < Array.from(BIG).length)
  assert.equal(isPreviewContent(a), true)
  // P2-4：工具身份 / 体量 / 截断标识（BIG=9000 > read 上限）都在预览里。
  assert.ok(text.includes('工具身份：Bash（callId=c1）'))
  assert.ok(text.includes('共 9000 字'))
  // G4：可实际分页 → 不再有「会截断、拿不到全文」的说法，而是「共 N 页 + 续读方式」。
  assert.ok(text.includes('共 ' + pagingOf(BIG).pages + ' 页'))
  assert.ok(text.includes('next_cursor'))
  assert.ok(text.includes('副本口径：记录正文与宿主原文的 content hash 一致'))
  // P1-1/P2-5：不再承诺逐字/精确原文。
  assert.equal(/逐字可回读|精确原文/.test(text), false)
})

test('P7-2 只外置纯文本超阈值：小文本/图文混排/已预览一律不碰', () => {
  assert.equal(shouldExternalize([{ type: 'text', text: BIG }], { thresholdChars: 100 }), true)
  assert.equal(shouldExternalize([{ type: 'text', text: 'short' }], { thresholdChars: 100 }), false)
  assert.equal(shouldExternalize([{ type: 'text', text: BIG }, { type: 'image', data: 'x' }], { thresholdChars: 100 }), false)
  // P2-11：判据从「整篇 includes」改成「首行头部形态」。旧断言把「正文以 token 开头」
  // 当作已预览——那只是**提到了标记**，真实数据（例如贴了一段本插件日志）会被永久跳过外置，
  // 状态面还误报 externalized。真正的已预览正文必须带完整回执头（含体量数字）。
  assert.equal(
    shouldExternalize([{ type: 'text', text: FIRST_INGRESS_TOKEN + ' 工具结果已外置（可回读副本）：共 999 字；' + BIG }], { thresholdChars: 100 }),
    false,
    '真正的外置回执头（含体量句式）不得重复外置',
  )
  assert.equal(
    shouldExternalize([{ type: 'text', text: FIRST_INGRESS_TOKEN + BIG }], { thresholdChars: 100 }),
    true,
    '正文只是提到标记、没有回执头 → 仍必须外置（P2-11）',
  )
  assert.equal(
    shouldExternalize([{ type: 'text', text: '日志里出现了 ' + FIRST_INGRESS_TOKEN + ' 这个标记。' + BIG }], { thresholdChars: 100 }),
    true,
    '标记出现在正文中段同样不得误判为已外置',
  )
})

test('P7-3 端口合法改写：活动面换成预览、原文仍在日志、请求级配对闭合', async () => {
  const { session, resultSeq } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const content = session.eventAt(resultSeq).data.message.content
  const preview = previewBlocksOf(previewArgs({ content, handle: 'v3r-0000000000000001' }))
  const before = session.events.length
  const res = await host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: contentHashOf(content), content: preview })

  assert.equal(res.shadowedSeq, resultSeq)
  assert.equal(res.seq, before)
  assert.deepEqual(session.surface.nodes, [0, 1, 2, res.seq])
  assert.equal(session.events.length, before + 1)
  // 原件一字未改（append-only 日志仍是恢复真源）
  assert.equal(session.eventAt(resultSeq).data.message.content[0].text, BIG)
  // 下一次请求派生到预览版
  const derived = session.deriveMessages().at(-1)
  assert.ok(derived.content[0].text.includes(FIRST_INGRESS_TOKEN))
  assert.ok(derived.content[0].text.includes('v3r-0000000000000001'))
  // 请求级配对校验：tool/result 改写不破坏调用闭合
  assert.equal(session.assertRequestBalanced(), true)
})

test('P7-4 端口失败关闭：hash 过期 / 非 tool-result / 非纯文本 / 已离面，均不落面', async () => {
  const { session, resultSeq } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const content = session.eventAt(resultSeq).data.message.content
  const preview = previewBlocksOf(previewArgs({ content, handle: 'v3r-0000000000000001' }))
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length

  await assert.rejects(
    () => host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: '0'.repeat(16), content: preview }),
    /hash/,
  )
  await assert.rejects(
    () => host.replaceToolResultContent({ seq: 1, expectedContentHash: contentHashOf(content), content: preview }),
    /tool\/result/,
  )
  await assert.rejects(
    () => host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: contentHashOf(content), content: [{ type: 'image', data: 'x' }] }),
    /纯文本/,
  )
  assert.deepEqual(session.surface.nodes, nodes, '任何拒绝都不得改面')
  assert.equal(session.events.length, logLen, '任何拒绝都不得写日志')

  // 正常替换一次后，同一原 seq 已离面：再次改写失败关闭
  await host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: contentHashOf(content), content: preview })
  await assert.rejects(
    () => host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: contentHashOf(content), content: preview }),
    /活动面/,
  )
})

test('P7-5 配对严格校验：user/message 顶掉单个 tool/result 能过 append，但请求派生必红', () => {
  const { session, resultSeq } = sessionWithResult()
  // 宿主允许（它只校验 content-only 的 tool/result 改写，不校验 user 覆盖结果节点）
  session.append('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'receipt' }], source: { kind: 'plugin' } }, {
    surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
    sourceEventSeqs: [resultSeq],
  })
  assert.throws(() => session.assertRequestBalanced(), SurfaceError)
  assert.throws(() => session.assertRequestBalanced(), /left without a result/)
})

test('P7-6 用例默认关闭：不给 enabled 时不读 store、不改面', async () => {
  const { session } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runFirstIngressPreview({ session, host, store })
  assert.deepEqual(out, { status: 'disabled', previewed: 0, skipped: 0, items: [] })
  assert.equal(store.calls.persist, 0)
  assert.equal(store.calls.read, 0)
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
})

test('P7-7 用例开启：先持久化并回读校验，再改面；下一次没有新结果就不再动作', async () => {
  const { session, resultSeq, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.status, 'ok')
  assert.equal(out.previewed, 1)
  assert.equal(out.skipped, 0)
  assert.equal(state.presentedThroughSeq, Math.max(...session.surface.nodes), '处理后水位推进到当前活动面最大 seq')
  const item = out.items[0]
  assert.equal(item.seq, resultSeq)
  assert.equal(item.presentedBefore, false)
  assert.equal(item.toolName, 'read')
  assert.equal(item.pages, pagingOf(BIG).pages, 'G4：可分页 → 报告页数而不是「读回会截断」')
  assert.ok(store.rows.get(item.recordId) === BIG, '原件按 ID 可回读')
  assert.ok(session.deriveMessages().at(-1).content[0].text.includes(item.recordId))

  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const again = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(again.status, 'ok')
  assert.equal(again.previewed, 0)
  assert.deepEqual(again.items, [], '没有新结果时不再产生改写项')
  assert.equal(again.accounting.newlyAppeared, 0)
  assert.equal(again.accounting.presentedFull, 0, '原结果已被预览遮蔽，不在面上，不再重复记账')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
})

test('P7-8 失败即保留原文：持久化抛错 / 回读不一致 都不改面', async () => {
  for (const mode of ['persist-failed', 'readback-mismatch']) {
    const { session, state } = sessionWithResult()
    const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
    const store = fakeStore()
    if (mode === 'persist-failed') store.persistOriginal = async () => { throw new Error('disk full') }
    else store.readOriginal = async () => ({ text: 'something else' })
    const nodes = [...session.surface.nodes]
    const logLen = session.events.length
    const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
    assert.equal(out.previewed, 0)
    assert.equal(out.skipped, 1)
    assert.equal(out.items[0].reason, mode)
    assert.deepEqual(session.surface.nodes, nodes)
    assert.equal(session.events.length, logLen)
    assert.equal(session.eventAt(3).data.message.content[0].text, BIG, '日志原文必须原样保留')
    assert.equal(session.deriveMessages().at(-1).content[0].text, BIG, '失败必须透传全文：请求面不得出现预览')
  }
})

test('P7-9 水位缺失失败关闭：没有「哪些已呈现过」的证据就不动作（§5）', async () => {
  const { session } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runFirstIngressPreview({ session, host, store, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.status, 'no-watermark')
  assert.equal(out.previewed, 0)
  assert.deepEqual(out.items, [])
  assert.equal(out.presentedThroughSeq, null)
  assert.equal(store.calls.persist, 0, '水位未知时连持久化都不做')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
})

test('P7-10 存在未闭合 tool-call 时整轮不替换（目标结果就在面上也不动）', async () => {
  const { session, state } = sessionWithResult()
  // 半完成步骤：assistant 声明 c2，结果还没落面
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: { id: 'm-c2', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'edit', arguments: '{}' }], source: { kind: 'model' } },
  }, { surfaceOp: 'append' })
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.status, 'pairing-unbalanced')
  assert.equal(out.previewed, 0)
  assert.equal(out.open, 1)
  assert.equal(store.calls.persist, 0, '配对不闭合时连持久化都不做')
  assert.deepEqual(session.surface.nodes, nodes, '绝不替换')
  assert.equal(session.events.length, logLen, '绝不写日志')
})

test('P7-11 回读入口复用既有工具面：ID 形状同 readRecord，不引入新工具名（G4）', () => {
  const legal = 'v3r-' + 'ab'.repeat(8)
  const surfaceContentHash = contentHashOf([{ type: 'text', text: BIG }])
  const entry = readEntryLinesOf({
    recordId: legal,
    sourceEventId: PREVIEW_SOURCE,
    externalId: externalIdOf({ sessionKey: 'p7-session', sourceEventId: PREVIEW_SOURCE, surfaceContentHash }),
    text: BIG,
    surfaceContentHash,
    recordTextHash: surfaceContentHash,
  })
  assert.ok(entry.join('\n').includes('memory_context_read ' + JSON.stringify({ id: legal, offset: 0, length: READBACK_MAX_CHARS })))
  assert.throws(() => readEntryLinesOf({ recordId: 'seq:12', text: BIG }), V3ContractViolation)
  assert.throws(() => readEntryLinesOf({ recordId: '../etc/passwd', text: BIG }), V3ContractViolation)
  assert.throws(() => readEntryLinesOf({ recordId: 'v3r-' + 'AB'.repeat(8), text: BIG }), V3ContractViolation, '大写/长度不符必须拒绝')
  const text = textOfBlocks(previewBlocksOf(previewArgs({ content: [{ type: 'text', text: BIG }], handle: legal })))
  // 工具集恒定：只准出现既有三工具里的 read；命令面只作为「不要依赖它」的提示出现。
  assert.equal(/memory_lab_|\brecall\(/.test(text), false, '不得印新工具名（工具集恒定）')
  assert.ok(text.includes('不是指令'), '预览必须标注不是指令')
})

test('P7-12 错误结果预览带状态行（不冒充成功）', async () => {
  const { session, state } = sessionWithResult(BIG, { isError: true })
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.previewed, 1)
  const text = session.deriveMessages().at(-1).content[0].text
  assert.ok(text.includes('isError=true'))
  assert.ok(text.includes('不得按预览判断成功'))
})

test('P7-13 预览以「已保存正文」为准：脱敏后的记录比宿主原文短，也按记录渲染', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  // 记录侧已脱敏：比宿主原文短得多，且不含原文里的 A 段
  const redacted = '[已脱敏] ' + 'R'.repeat(3000)
  const store = fakeStore({ storedText: redacted, surfaceHashMatched: false })
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.previewed, 1)
  const text = session.deriveMessages().at(-1).content[0].text
  assert.ok(text.includes('共 ' + Array.from(redacted).length + ' 字'), '字数按记录正文算：' + text.slice(0, 80))
  assert.equal(text.includes('AAAA'), false, '不得把宿主原始字节（可能含未脱敏内容）印进预览')
  assert.ok(text.includes('memory_context_read ' + JSON.stringify({ id: out.items[0].recordId, offset: 0, length: READBACK_MAX_CHARS })))
  assert.ok(text.includes('content hash 不一致'), '脱敏副本必须如实标注，不得当原文')
  assert.ok(text.includes('不得当作宿主原文'))
})

test('P7-14 最新优先 + 只处理本次新出现：历史结果不动、最新的先换、每步受 maxPerStep', async () => {
  const session = new FakeSession({ id: 'p7-order' })
  session.append('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
  const old1 = appendOp(session, { callId: 'c1' })
  const old2 = appendOp(session, { callId: 'c2' })
  // 这两条已经进入过请求：水位停在它们之后
  const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
  const newer = appendOp(session, { callId: 'c3' })
  const newest = appendOp(session, { callId: 'c4' })

  const host = createDshHostAdapter({ session, sessionKey: 'p7-order' })
  const store = fakeStore()
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100, maxPerStep: 1 } })
  assert.equal(out.previewed, 1)
  assert.equal(out.items[0].seq, newest, '必须先换最新的那个')
  assert.equal(out.accounting.newlyAppeared, 2)
  assert.ok(session.deriveMessages().at(-1).content[0].text.includes(FIRST_INGRESS_TOKEN))
  // 同批另一个新结果与两条历史结果都保持全文（请求面按原样派生）
  const surfaceText = (seq) => {
    const node = session.surface.nodes.indexOf(seq)
    const event = session.eventAt(session.surface.nodes[node])
    return event.data.message.content[0].text
  }
  assert.equal(surfaceText(old1), BIG)
  assert.equal(surfaceText(old2), BIG)
  assert.equal(surfaceText(newer), BIG)

  // 下一次：没有新结果；剩下的大结果都只是「已全文呈现过」的记账，不改写
  const again = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100, maxPerStep: 1 } })
  assert.equal(again.previewed, 0)
  assert.equal(again.accounting.presentedFull, 3, '未改写的历史/剩余结果逐条记账')
  assert.equal(again.accounting.presentedThenArchived, 0)
})

test('P7-15 已先全文呈现过的结果默认不改写；显式 rewritePresented 才改写且单独记账', async () => {
  const { session, resultSeq } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  // 模拟「结果已进入过一次请求」：水位推过结果本身
  const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length

  const held = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(held.previewed, 0)
  assert.equal(held.accounting.presentedFull, 1)
  assert.deepEqual(session.surface.nodes, nodes, '默认不消费后再改写')
  assert.equal(session.events.length, logLen)

  const opted = await runFirstIngressPreview({
    session,
    host,
    store,
    state,
    config: { enabled: true, thresholdChars: 100, rewritePresented: true },
  })
  assert.equal(opted.previewed, 1)
  assert.equal(opted.items[0].seq, resultSeq)
  assert.equal(opted.items[0].presentedBefore, true)
  assert.equal(opted.accounting.presentedThenArchived, 1, '消费后归档成本必须单独记账')
})

test('P7-16 回读来源不二次外置（P2-3）：带 readbackOf / 插件来源形态的 tool/result 原样保留', async () => {
  for (const messageSource of [
    { kind: 'tool', callId: 'c1', readbackOf: 'v3r-' + 'ab'.repeat(8) },
    { kind: 'tool', callId: 'c1', form: 'restore' },
    { kind: 'dsh-memory-context-lab', form: 'recall' },
  ]) {
    const session = new FakeSession({ id: 'p7-readback' })
    session.append('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' })
    session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
    const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
    appendOp(session, { callId: 'c1', messageSource })
    const host = createDshHostAdapter({ session, sessionKey: 'p7-readback' })
    const store = fakeStore()
    const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
    assert.equal(out.previewed, 0, JSON.stringify(messageSource))
    assert.equal(out.items[0].reason, 'readback-source')
    assert.equal(store.calls.persist, 0, '回读来源连持久化都不做')
    assert.equal(session.deriveMessages().at(-1).content[0].text, BIG)
  }
})

test('P7-17 预览保留工具身份/错误态/体量/句柄/截断标识（P2-4）', async () => {
  const { session, state } = sessionWithResult(BIG, { isError: true })
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })
  const item = out.items[0]
  assert.equal(item.toolName, 'read')
  assert.equal(item.callId, 'c1')
  assert.equal(item.isError, true)
  assert.equal(item.exactCopy, true)
  assert.equal(item.pages, pagingOf(BIG).pages, 'G4：可分页 → 报告页数而不是「读回会截断」')
  const text = session.deriveMessages().at(-1).content[0].text
  assert.ok(text.includes('工具身份：read（callId=c1）'))
  assert.ok(text.includes('memory_context_read ' + JSON.stringify({ id: item.recordId, offset: 0, length: READBACK_MAX_CHARS })))
  assert.ok(text.includes('共 9000 字'))
  assert.ok(text.includes('未展示范围：码点 600–8800'))
  assert.ok(text.includes('isError=true'))

  // 找不到调用声明时如实写「未知」，不拿占位名冒充
  const unknown = previewBlocksOf(previewArgs({ content: [{ type: 'text', text: BIG }], handle: 'v3r-' + 'ab'.repeat(8), toolName: null, callId: 'c9' }))
  assert.ok(textOfBlocks(unknown).includes('工具身份：未知'))
})

test('P7-18 写入后确认失败 = 独立状态（P2-1）：落面被改成 TAMPERED 时不得宣称原文仍全文', async () => {
  const { session, state } = sessionWithResult()
  const realAppend = session.append.bind(session)
  // 替身：append 成功后把落面正文改成 TAMPERED（模拟宿主/另一写者让复核失败）
  session.append = (type, data, opts) => {
    const event = realAppend(type, data, opts)
    if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') {
      session.events[event.seq].data.message.content = [{ type: 'text', text: 'TAMPERED' }]
    }
    return event
  }
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const store = fakeStore()
  const watermarkBefore = state.presentedThroughSeq
  const out = await runFirstIngressPreview({ session, host, store, state, config: { enabled: true, thresholdChars: 100 } })

  assert.equal(out.status, 'rewritten-unconfirmed', '必须与 replace-failed 分开上报')
  assert.equal(out.rewritten, 1)
  assert.equal(out.unconfirmed, 1)
  assert.equal(out.previewed, 0, '确认失败不算一次成功外置')
  assert.equal(out.accounting.unconfirmed, 1)
  const item = out.items[0]
  assert.equal(item.reason, 'replaced-unconfirmed')
  assert.equal(item.rewritten, true)
  assert.equal(item.confirmed, false)
  assert.equal(item.charsAfter, null, '不得给出「已按预期缩短」的数字')
  assert.equal(state.presentedThroughSeq, watermarkBefore, '确认失败不推进水位')
  // 请求面确实已经变了：派生消息是 TAMPERED，不是原文
  assert.equal(session.deriveMessages().at(-1).content[0].text, 'TAMPERED')
})

test('P7-19 端口绝不降级成 user/message replace（P2-2）', async () => {
  const { session, resultSeq, state } = sessionWithResult()
  const realAppend = session.append.bind(session)
  session.append = (type, data, opts) => {
    if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') throw new Error('DSH: 拒绝受限改写')
    return realAppend(type, data, opts)
  }
  const host = createDshHostAdapter({ session, sessionKey: 'p7-session' })
  const content = session.eventAt(resultSeq).data.message.content
  const preview = previewBlocksOf(previewArgs({ content, handle: 'v3r-0000000000000001' }))
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  await assert.rejects(
    () => host.replaceToolResultContent({ seq: resultSeq, expectedContentHash: contentHashOf(content), content: preview }),
    (error) => error?.code === 'EINTERNAL',
  )
  assert.deepEqual(session.surface.nodes, nodes, '拒绝后活动面不得被别的形态顶掉')
  assert.equal(session.events.length, logLen, '拒绝后不得 append 兜底消息')
  assert.equal(session.events.slice(logLen).filter((event) => event.type === 'user/message').length, 0, '拒绝后不得 append 兜底 user/message')

  // 用例层也不得自己降级：宿主端口被拒时调用通用 surfaceOp 就是重复缺陷
  let surfaceOpCalls = 0
  const guardedHost = {
    replaceToolResultContent: host.replaceToolResultContent,
    surfaceOp: async () => { surfaceOpCalls += 1; throw new Error('surfaceOp must not be used') },
  }
  const out = await runFirstIngressPreview({ session, host: guardedHost, store: fakeStore(), state, config: { enabled: true, thresholdChars: 100 } })
  assert.equal(out.items[0].reason, 'replace-failed')
  assert.equal(surfaceOpCalls, 0, '用例不得降级到通用 surfaceOp（会留下未闭合调用）')
})

test('P7-20 阈值与 read 上限同源（P1-1）：阈值由常量派生、严格小于上限、全仓不另写 8000', async () => {
  assert.equal(FIRST_INGRESS_DEFAULTS.thresholdChars, FIRST_INGRESS_THRESHOLD_CHARS)
  assert.ok(FIRST_INGRESS_THRESHOLD_CHARS < READBACK_MAX_CHARS, '外置阈值必须低于回读上限，否则句柄承诺不成立')
  assert.ok(READBACK_MAX_CHARS - FIRST_INGRESS_THRESHOLD_CHARS >= 1000, '必须留出可解释的安全余量')

  // 量具自检：扫描面非空，且确实能扫到 readback 契约里的那个数字
  const srcRoot = path.join(here, '..', 'src')
  async function walk(dir) {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await walk(full)))
      else if (entry.name.endsWith('.mjs')) out.push(full)
    }
    return out
  }
  const files = await walk(srcRoot)
  assert.ok(files.length >= 20, '扫描面异常：' + files.length)
  const hits = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (/\b8000\b/.test(text)) hits.push(path.relative(srcRoot, file).replaceAll('\\', '/'))
  }
  assert.deepEqual(hits, ['v3/contracts/readback.mjs'], '回读上限只准出现在单一真源，别处再写数字就是 P1-1 复发')

  // 同尺行为：码点少、UTF-16 长的正文照样按 read 的截断尺判定（3001 emoji = 6002 UTF-16 > 6000）
  const emoji = '😀'.repeat(3001)
  assert.equal(emoji.length, 6002)
  assert.equal(shouldExternalize([{ type: 'text', text: emoji }]), true, '阈值判定必须用 UTF-16 长度（与 read 截断同尺）')
  const preview = textOfBlocks(previewBlocksOf(previewArgs({ content: [{ type: 'text', text: emoji }], handle: 'v3r-' + 'ab'.repeat(8) })))
  // 6002 码点 = 1 页：回执如实写「共 1 页」，且页上界与 read 同源（不写死数字）。
  assert.ok(preview.includes('共 1 页'), preview.slice(0, 400))
  assert.equal(pagingOf(emoji).pageChars, READBACK_MAX_CHARS, '页上界只来自单一真源')
})

test('P7-21 空正文拒绝（P3 定点变异目标）：没有可外置内容时抛契约违规', () => {
  assert.throws(() => previewBlocksOf(previewArgs({ content: [{ type: 'text', text: '' }], handle: 'v3r-' + 'ab'.repeat(8) })), V3ContractViolation)
  assert.throws(() => previewBlocksOf(previewArgs({ content: [], handle: 'v3r-' + 'ab'.repeat(8) })), V3ContractViolation)
})
