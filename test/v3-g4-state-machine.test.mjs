/**
 * G4 状态机与故障注入（离线子集）：持久化 → 回读核验 → 替换表层 → 确认实际呈现。
 *
 * ## 判据来源
 * 开发流程 §10 的故障清单，逐条断言**持久层 / 表层 / 报告**三者一致；一致性由
 * reconcileFirstIngress 的同一套规则计算（不是测试里另写一套）：
 * - 报告 ok ⇒ 表层必须是本机制的回执且持久层可读；
 * - 报告 replaced-unconfirmed / post-replace-generation-changed ⇒ 表层必须**不是**原文；
 * - 其余失败/取消 ⇒ 表层必须仍是原文；有 recordId 的持久层必须可读，没有的必须未持久化。
 *
 * ## 这一套证明什么
 * 每种失败都有**独立结局**（不是「被拒绝，原文仍在」一句话罩住），重试按幂等 ID 与表层状态
 * 对账，取消/迟到回调/进程重启/并发重入都不制造第二份外置或假成功。
 *
 * ## 不证明什么
 * 真实宿主时序（替换是否发生在目标请求之前）、其他 hooked 插件次序、wire 可见性未验（留 G8）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeSession } from './helpers/fake-host.mjs'
import { createDshHostAdapter } from '../src/v3/adapters/host/dsh-host.mjs'
import { runFirstIngressPreview, reconcileFirstIngress } from '../src/v3/application/first-ingress.mjs'
import {
  FIRST_INGRESS_TOKEN,
  contentHashOf,
  isPreviewContent,
} from '../src/v3/domain/first-ingress/preview.mjs'
import { OWN_TOOL_RESULT_MARKER } from '../src/v3/contracts/tools.mjs'

const BIG = 'A'.repeat(9000)
const KEY = 'g4-sm'

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

/** 基准会话：系统 + 用户消息已入过请求（水位停在它们之后），结果事件是「本次新出现」。 */
function sessionWithResult(text = BIG, { isError = false, id = KEY } = {}) {
  const session = new FakeSession({ id })
  session.append('system/message', {
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
  const resultSeq = appendOp(session, { callId: 'c1', text, isError })
  return { session, resultSeq, state }
}

/**
 * 记录端口替身：与真实适配器同形（recordId / text / recordTextHash / surfaceHashMatched / generation），
 * 额外支持「读回期间遗忘」「替换后遗忘」两种注入（真实适配器由 store 的遗忘账本驱动）。
 */
function fakeStore({ storedText = BIG, surfaceHashMatched = true } = {}) {
  const rows = new Map()
  const calls = { persist: 0, read: 0, gen: 0 }
  let n = 0
  const textHash = (text) => contentHashOf([{ type: 'text', text }])
  const store = {
    rows,
    calls,
    hooks: { forgetDuringReadback: false },
    async persistOriginal({ seq } = {}) {
      calls.persist += 1
      n += 1
      const recordId = 'v3r-' + String(n).padStart(16, '0')
      rows.set(recordId, { text: storedText, forgotten: false })
      return {
        recordId,
        text: storedText,
        recordTextHash: textHash(storedText),
        surfaceEventId: 'dsh-' + seq,
        surfaceHashMatched,
        recordErrorMarked: false,
        callIdAttested: null,
        generation: textHash(storedText),
      }
    },
    async readOriginal(recordId) {
      calls.read += 1
      const row = rows.get(recordId)
      if (row === undefined) throw Object.assign(new Error('记录不存在'), { code: 'ERECORD_NOT_FOUND' })
      if (row.forgotten) throw Object.assign(new Error('已遗忘'), { code: 'EFORGOTTEN' })
      if (store.hooks.forgetDuringReadback) row.forgotten = true
      return { text: row.text, recordTextHash: textHash(row.text), generation: textHash(row.text) }
    },
    async generationOf(recordId) {
      calls.gen += 1
      const row = rows.get(recordId)
      if (row === undefined) return { readable: false, forgotten: false, digest: 'unreadable:ERECORD_NOT_FOUND' }
      if (row.forgotten) return { readable: false, forgotten: true, digest: 'unreadable:EFORGOTTEN' }
      return { readable: true, forgotten: false, digest: textHash(row.text) }
    },
  }
  return store
}

async function runOnce(opts = {}) {
  return await runFirstIngressPreview({
    session: opts.session,
    host: opts.host,
    store: opts.store,
    state: opts.state,
    config: { enabled: true, thresholdChars: 100, ...(opts.config ?? {}) },
    signal: opts.signal ?? null,
    sessionKey: KEY,
  })
}

/** 对账：同一批 items 的持久层/表层/报告必须三者一致（不一致直接打印行）。 */
async function assertConsistent({ session, store, items }) {
  const out = await reconcileFirstIngress({ session, store, items })
  const bad = out.rows.filter((row) => row.consistent !== true)
  assert.deepEqual(bad, [], '三态不一致：' + JSON.stringify(bad))
  return out
}

test('G4-S1 成功路径：先持久化再回读核验再替换，报告带收益与页数，三态一致', async () => {
  const { session, resultSeq, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.status, 'ok')
  assert.equal(out.previewed, 1)
  const item = out.items[0]
  assert.equal(item.reason, undefined)
  assert.equal(item.seq, resultSeq)
  assert.equal(item.charsBefore, BIG.length)
  assert.ok(item.charsAfter > 0 && item.charsAfter < item.charsBefore, '回执必须比正文短')
  assert.ok(item.pages >= 1)
  assert.equal(out.accounting.sourceChars, BIG.length)
  assert.equal(out.accounting.receiptChars, item.charsAfter)
  assert.equal(out.accounting.netChars, out.accounting.sourceChars - out.accounting.receiptChars)
  assert.ok(out.accounting.netChars > 0, '回执大小必须计入收益（净收益为正）')
  assert.equal(state.presentedThroughSeq, Math.max(...session.surface.nodes), '成功后水位推进到当前活动面')
  const preview = session.deriveMessages().at(-1).content[0].text
  assert.ok(preview.includes(FIRST_INGRESS_TOKEN))
  assert.ok(preview.includes(item.externalId))
  await assertConsistent({ session, store, items: out.items })
})

test('G4-S2 落盘失败：表层保持原文，报告独立结局，持久层未持久化', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  store.persistOriginal = async () => { throw Object.assign(new Error('disk full'), { code: 'ESTORE_DAMAGED' }) }
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'persist-failed')
  assert.deepEqual(session.surface.nodes, nodes, '不改面')
  assert.equal(session.events.length, logLen, '不写日志')
  assert.equal(session.deriveMessages().at(-1).content[0].text, BIG, '失败必须透传全文')
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'original')
  assert.equal(rec.rows[0].persistence, 'not-persisted')
})

test('G4-S3 回读不一致：不改面，报告 readback-mismatch，持久层仍可读', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  store.readOriginal = async () => ({ text: 'TAMPERED' })
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'readback-mismatch')
  assert.ok(out.items[0].recordId.length > 0)
  assert.deepEqual(session.surface.nodes, nodes)
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'original')
  assert.equal(rec.rows[0].persistence, 'changed', '记录可读但内容已经不是那一份：对账如实显示 changed（不是 readable）')
})

test('G4-S4 替换抛错：原文仍在面上，报告 replace-failed（不是 rewritten）', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  host.replaceToolResultContent = async () => { throw Object.assign(new Error('宿主拒绝'), { code: 'EINTERNAL' }) }
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 0)
  assert.equal(out.rewritten, 0)
  assert.equal(out.items[0].reason, 'replace-failed')
  assert.equal(out.items[0].rewritten, undefined)
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.deriveMessages().at(-1).content[0].text, BIG)
  await assertConsistent({ session, store, items: out.items })
})

test('G4-S5 替换成功后确认丢失：独立状态 rewritten-unconfirmed，不推进水位，不宣称原文仍在', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const realAppend = session.append.bind(session)
  session.append = (type, data, opts) => {
    const event = realAppend(type, data, opts)
    if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') {
      session.events[event.seq].data.message.content = [{ type: 'text', text: 'TAMPERED' }]
    }
    return event
  }
  const watermarkBefore = state.presentedThroughSeq
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.status, 'rewritten-unconfirmed')
  assert.equal(out.rewritten, 1)
  assert.equal(out.unconfirmed, 1)
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'replaced-unconfirmed')
  assert.equal(out.items[0].charsAfter, null)
  assert.equal(state.presentedThroughSeq, watermarkBefore, '确认失败不推进水位')
  assert.equal(session.deriveMessages().at(-1).content[0].text, 'TAMPERED', '请求面确实变了：不得说原文仍在')
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'diverged', '既不是原文也不是我们的回执：如实报 diverged')
  assert.equal(rec.rows[0].report, 'replaced-unconfirmed')
})

test('G4-S6 并发/重入：两个同时运行的用例只产生一次替换，第二个不制造第二份外置', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const logLen = session.events.length
  const [a, b] = await Promise.all([
    runOnce({ session, host, store, state }),
    runOnce({ session, host, store, state }),
  ])
  const replaces = session.events.length - logLen
  assert.equal(replaces, 1, '活动面只允许被替换一次（另一个必须失败关闭）')
  assert.equal(a.previewed + b.previewed, 1)
  const surfaces = session.surface.nodes.filter((seq) => isPreviewContent(session.eventAt(seq)?.data?.message?.content))
  assert.equal(surfaces.length, 1, '面上只能有一份本机制回执')
  const items = [...(a.items ?? []), ...(b.items ?? [])]
  assert.equal(items.filter((item) => item.reason === undefined).length, 1)
  await assertConsistent({ session, store, items })
})

test('G4-S7 进程重启（水位丢失）：整轮不动作，表层/持久层不变，报告 no-watermark', async () => {
  const { session } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runOnce({ session, host, store })
  assert.equal(out.status, 'no-watermark')
  assert.deepEqual(out.items, [])
  assert.equal(store.calls.persist, 0, '水位未知时连持久化都不做')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
})

test('G4-S8 迟到回调（替换期间被取消）：替换已确认就必须报成功，但水位不推进', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const signal = { aborted: false }
  const realReplace = host.replaceToolResultContent.bind(host)
  host.replaceToolResultContent = async (args) => {
    signal.aborted = true
    return await realReplace(args)
  }
  const watermarkBefore = state.presentedThroughSeq
  const out = await runOnce({ session, host, store, state, signal })
  assert.equal(out.status, 'ok')
  assert.equal(out.previewed, 1)
  assert.equal(out.items[0].cancelledAfterReplace, true, '取消发生在替换之后：如实标注，不撤销既成事实')
  assert.equal(state.presentedThroughSeq, watermarkBefore, '取消后不推进水位（下一次按旧水位复核）')
  assert.ok(session.deriveMessages().at(-1).content[0].text.includes(FIRST_INGRESS_TOKEN))
  await assertConsistent({ session, store, items: out.items })
})

test('G4-S9 取消（替换前）：保留原文、报告 cancelled，持久层不变', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const signal = { aborted: true }
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const out = await runOnce({ session, host, store, state, signal })
  assert.equal(out.status, 'cancelled')
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'cancelled-before-replace')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
  assert.equal(session.deriveMessages().at(-1).content[0].text, BIG)
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'original')
  assert.equal(rec.rows[0].persistence, 'not-persisted')
})

test('G4-S10 跨会话/错误归属的记录：端口拒绝即失败关闭，不改面', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  store.persistOriginal = async () => { throw Object.assign(new Error('不属于本会话'), { code: 'ESTORE_SESSION_MISMATCH' }) }
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.items[0].reason, 'persist-failed')
  assert.equal(out.items[0].error, 'ESTORE_SESSION_MISMATCH')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.deriveMessages().at(-1).content[0].text, BIG)
})

test('G4-S11 脱敏改变长度：按记录正文外置，两种哈希分别出现在报告里', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const redacted = '[已脱敏] ' + 'R'.repeat(3000)
  const store = fakeStore({ storedText: redacted, surfaceHashMatched: false })
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 1)
  const item = out.items[0]
  assert.equal(item.charsBefore, redacted.length, '体量按落库正文算')
  assert.equal(item.exactCopy, false)
  assert.notEqual(item.recordTextHash, item.surfaceContentHash, '两种 hash 不互换')
  assert.equal(item.surfaceContentHash, contentHashOf([{ type: 'text', text: BIG }]), '原文 hash 来自宿主原文')
  assert.equal(item.recordTextHash, contentHashOf([{ type: 'text', text: redacted }]), '副本 hash 来自落库正文')
  const text = session.deriveMessages().at(-1).content[0].text
  assert.ok(text.includes('content hash 不一致'))
  assert.equal(text.includes('AAAA'), false, '不得把宿主原文印进回执')
  await assertConsistent({ session, store, items: out.items })
})

test('G4-S12 混合媒体：非纯文本一律不碰（连持久化都不做）', async () => {
  const session = new FakeSession({ id: KEY })
  session.append('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
  const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
  session.append('assistant/message', { message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: BIG }, { type: 'image', data: 'x' }], toolCallId: 'c1', isError: false } }, { surfaceOp: 'append' })
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.status, 'ok')
  assert.equal(out.previewed, 0)
  assert.equal(store.calls.persist, 0, '图文混排不进入持久化')
  assert.deepEqual(session.surface.nodes, nodes)
})

test('G4-S13 读回工具再次进入入口：自带工具结果标记/来源形态的结果不二次外置', async () => {
  const cases = [
    { text: OWN_TOOL_RESULT_MARKER + '\n' + BIG },
    { text: BIG, messageSource: { kind: 'tool', callId: 'c1', readbackOf: 'v3r-' + 'cd'.repeat(8) } },
    { text: BIG, messageSource: { kind: 'dsh-memory-context-lab', form: 'recall' } },
  ]
  for (const row of cases) {
    const session = new FakeSession({ id: KEY })
    session.append('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' })
    session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
    const state = { presentedThroughSeq: Math.max(...session.surface.nodes) }
    appendOp(session, { callId: 'c1', text: row.text, messageSource: row.messageSource })
    const host = createDshHostAdapter({ session, sessionKey: KEY })
    const store = fakeStore()
    const out = await runOnce({ session, host, store, state })
    assert.equal(out.previewed, 0, JSON.stringify(row.messageSource ?? row.text.slice(0, 20)))
    assert.equal(out.items[0].reason, 'readback-source')
    assert.equal(store.calls.persist, 0, '回读来源连持久化都不做')
  }
})

test('G4-S14 回读期间被遗忘：代际变化 → 不改面，报告 generation-changed', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  store.hooks.forgetDuringReadback = true
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'generation-changed')
  assert.deepEqual(session.surface.nodes, nodes, '遗忘发生后绝不再改写表层')
  assert.equal(session.deriveMessages().at(-1).content[0].text, BIG)
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'original')
})

test('G4-S15 替换后被遗忘：不得宣称成功（rewritten-unconfirmed），表层已变的事实保留', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const realReplace = host.replaceToolResultContent.bind(host)
  host.replaceToolResultContent = async (args) => {
    const out = await realReplace(args)
    for (const row of store.rows.values()) row.forgotten = true
    return out
  }
  const watermarkBefore = state.presentedThroughSeq
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.status, 'rewritten-unconfirmed')
  assert.equal(out.items[0].reason, 'post-replace-generation-changed')
  assert.equal(out.previewed, 0)
  assert.equal(state.presentedThroughSeq, watermarkBefore)
  assert.ok(session.deriveMessages().at(-1).content[0].text.includes(FIRST_INGRESS_TOKEN))
  const rec = await assertConsistent({ session, store, items: out.items })
  assert.equal(rec.rows[0].surface, 'externalized')
  assert.equal(rec.rows[0].persistence, 'forgotten', '正文已遗忘：报告必须如实反映，而不是「已可读」')
})

test('G4-S16 幂等重入：第二次运行不再替换，只记 alreadyExternalized（items 为空）', async () => {
  const { session, state } = sessionWithResult()
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore()
  const first = await runOnce({ session, host, store, state })
  assert.equal(first.previewed, 1)
  const nodes = [...session.surface.nodes]
  const logLen = session.events.length
  const calls = store.calls.persist
  const second = await runOnce({ session, host, store, state })
  assert.equal(second.status, 'ok')
  assert.equal(second.previewed, 0)
  assert.deepEqual(second.items, [])
  assert.equal(second.accounting.alreadyExternalized, 1, '幂等判据：面上已是本机制回执')
  assert.equal(store.calls.persist, calls, '已外置的正文不再走持久化')
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.events.length, logLen)
})

test('G4-S17 回执不小于正文时拒绝外置（收益口径）：not-worth，不改面', async () => {
  const small = 'C'.repeat(700)
  const { session, state } = sessionWithResult(small)
  const host = createDshHostAdapter({ session, sessionKey: KEY })
  const store = fakeStore({ storedText: small })
  const nodes = [...session.surface.nodes]
  const out = await runOnce({ session, host, store, state })
  assert.equal(out.previewed, 0)
  assert.equal(out.items[0].reason, 'not-worth')
  assert.ok(out.items[0].receiptChars >= out.items[0].sourceChars)
  assert.equal(out.accounting.notWorth, 1)
  assert.deepEqual(session.surface.nodes, nodes)
  assert.equal(session.deriveMessages().at(-1).content[0].text, small)
})
