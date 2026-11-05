/**
 * G2：有界引用链与可靠回读（0.15.0；F03 的验收面）。
 *
 * 这份套件只证明「链条可用、有界、可续读」，不证明真实模型会主动找对证据（留给 G8）。
 * 三条断言主线：
 * 1. **两条链分开**：普通自动归档回执 → 原记录（archive-receipt，靠 voucher）；
 *    协作 compact 回执 → SummaryArtifact → 来源记录（segment-summary + source）。
 *    普通回执**不得**被包装成「已有摘要工件」——它的 detail 必须明说「没有 SummaryArtifact」。
 * 2. **真实关系分开**：call/result 配对靠同一 callId（相隔多步也成立），
 *    相邻只标 adjacent 且文案自带「非因果」——不许把序号邻近当因果。
 * 3. **有界可续读**：正文按码点分页、引用按引用序号分页，两者游标都是 v1.* 且绑定对象版本；
 *    每页正文 ≤ 8000 码点、每页引用 ≤ 页上界，渲染总长有上界（不因引用链撑爆上下文）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createMemoryContextTools } from '../src/v3/entry/tools.mjs'
import { MEMORY_CONTEXT_TOOL_NAMES } from '../src/v3/contracts/tools.mjs'
import { READ_REFS_LIMITS } from '../src/v3/contracts/citations.mjs'
import { READBACK_MAX_CHARS } from '../src/v3/contracts/readback.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const RECORD_ID_RE = /v3r-[0-9a-f]{16}/g

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 60))
}

/**
 * 真实宿主暴露 `session.events`（dsh-host 的 `events()` 读它）；共享假会话夹具没建模这一面。
 * 这里按测试需要补上**同一形状**（只读返回日志），不改共享夹具（它属于其它批次）。
 */
function withEvents(session) {
  session.events = () => session.log
  return session
}

async function mount(root) {
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  return { ctx, engine }
}

test('链 A：只给回执也能按 ID 读回原记录，并给出「所属归档回执」；普通回执不冒充摘要工件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-chain-a-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-a' }))
    session.pushUser('第一问：链 A 的原文-U1'.repeat(30))
    session.pushAssistant('第一答：链 A 的原文-A1'.repeat(30))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.summaryId, null, '普通自动归档不产生 SummaryArtifact（只有内联短摘要）')
    assert.ok(typeof archived.voucherId === 'string' && archived.voucherId.startsWith('v-'))

    // —— 确定性驱动器：**只拿到回执文本**，从中解析记录 ID 再回读 ——
    const idsFromReceipt = [...new Set(archived.receiptText.match(RECORD_ID_RE) ?? [])]
    assert.ok(idsFromReceipt.length >= 1, '回执必须带可回读的记录 ID（基础身份不得被挤掉）')
    assert.ok(idsFromReceipt.every((id) => archived.recordIds.includes(id)), '回执里的 ID 必须是本段真实记录')

    let sawText = false
    for (const id of idsFromReceipt) {
      const read = await engine.toolRead(session.id, id, { detail: 'full' })
      assert.equal(read.status, 'ok', id + '：' + JSON.stringify(read))
      assert.equal(read.visible, true)
      assert.equal(typeof read.text, 'string')
      assert.equal(read.offset, 0)
      assert.equal(read.offset_unit, 'code-point')
      if (/U1/.test(read.text) || /A1/.test(read.text)) sawText = true
      // 链 A 的引用：覆盖它的回执（凭 voucher，不是凭序号猜）
      const receipt = read.related.find((ref) => ref.relation === 'archive-receipt')
      assert.ok(receipt !== undefined, id + ' 必须给出所属归档回执')
      assert.equal(receipt.kind, 'voucher')
      assert.equal(receipt.id, archived.voucherId)
      assert.equal(receipt.status, 'ok')
      assert.equal(receipt.seq, archived.receiptSeq)
      assert.equal(receipt.start_seq, archived.startSeq)
      assert.equal(receipt.end_seq, archived.endSeq)
      // **反例**：普通回执不得被包装成摘要工件
      assert.equal(read.related.filter((ref) => ref.relation === 'segment-summary').length, 0,
        '普通自动归档回执没有 SummaryArtifact，不得伪造 segment-summary 引用')
      assert.match(receipt.detail, /没有 SummaryArtifact/, '回执引用必须明说它是普通回执（只有内联短摘要）')
      assert.ok(read.refs_total <= 1 + READ_REFS_LIMITS.receipts + 1 + 2, '记录侧引用条数有界')
    }
    assert.equal(sawText, true, '按回执 ID 必须能读回原文')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('链 B：协作 compact 回执 → SummaryArtifact → 来源记录（逐跳 hash/会话/可见性核验）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-chain-b-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-b' }))
    session.pushUser('第一问：链 B 原文-U2'.repeat(30))
    session.pushAssistant('第一答：链 B 原文-A2'.repeat(30))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const inspected = await engine.inspectCompact(session.id, session)
    assert.equal(inspected.status, 'ok', JSON.stringify(inspected))
    // evidenceRefs 必须是 sources 的子集：这里先把候选来源列出来，再挑一条做证据引用。
    const candidateSources = inspected.identity.recordIds
    const prepared = await engine.prepareCompact(session.id, session, {
      candidate_id: inspected.candidate_id,
      summary: {
        shortText: '摘要短文本-ZQ9',
        detail: '摘要详细正文-ZQ9：定位到问题并修复。',
        outcome: 'partial',
        evidenceRefs: [candidateSources[0]],
      },
    })
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
    const summaryId = prepared.summary_id
    const submitted = await engine.submitCompact(session.id, session, { proposal_id: prepared.proposal_id })
    assert.equal(submitted.accepted, true)
    session.pushUser('尾部追加：让候选成为已完成回合'.repeat(3))
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.summaryId, summaryId, '协作路径的凭证必须带 summaryRef（链 B 的入口）')

    // 1) 摘要 → 来源记录
    const summaryRead = await engine.toolRead(session.id, summaryId, { detail: 'short' })
    assert.equal(summaryRead.status, 'ok', JSON.stringify(summaryRead))
    assert.equal(summaryRead.type, 'summary')
    assert.equal(summaryRead.object_version_kind, 'summary-artifact-hash')
    assert.ok(summaryRead.sources.length >= 1, '摘要读取必须给出有界来源区')
    const recordById = new Map()
    for (const id of candidateSources) {
      recordById.set(id, await engine.toolRead(session.id, id, { detail: 'full' }))
    }
    for (const ref of summaryRead.sources) {
      assert.equal(ref.kind, 'record')
      assert.equal(ref.status, 'ok', ref.id + ' 来源必须逐跳核验通过（' + ref.status + '）')
      assert.equal(ref.hash_kind, 'record-source')
      const recordRead = recordById.get(ref.id)
      assert.ok(recordRead !== undefined, 'sources 必须指向本段真实记录')
      assert.equal(ref.hash, recordRead.source_hash, '引用上的 hash 必须等于该记录的字节 hash（C-G2-07）')
      assert.notEqual(ref.hash, summaryRead.source_hash, '来源记录 hash 与摘要工件指纹不可互换')
    }
    // 证据引用（C-G2-02：evidenceRefs ⊆ sources）
    assert.deepEqual(summaryRead.evidence_refs, [candidateSources[0]])
    const evidence = summaryRead.related.find((ref) => ref.relation === 'evidence')
    assert.ok(evidence !== undefined, '证据引用必须单独一个 relation（不是第二条来源）')
    assert.equal(evidence.id, candidateSources[0])
    assert.equal(evidence.status, 'ok')

    // 2) 来源记录 → 该段落的摘要工件（链 B 的反向入口）
    const sourceRead = recordById.get(candidateSources[0])
    const segment = sourceRead.related.find((ref) => ref.relation === 'segment-summary')
    assert.ok(segment !== undefined, '被协作摘要覆盖的记录必须能回到摘要工件')
    assert.equal(segment.id, summaryId)
    assert.equal(segment.kind, 'summary')
    assert.equal(segment.status, 'ok')
    // 同一个 referenced 段还有所属回执（链 A），两条链并存但不混为一谈
    assert.ok(sourceRead.related.some((ref) => ref.relation === 'archive-receipt'))
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('call/result 相隔多步仍是同一 callId 的真实配对；相邻只标 adjacent 且「非因果」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-pair-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-pair' }))
    session.pushUser('配对测试：先发一条'.repeat(3))
    session.pushAssistantWithToolCall('声明调用 call-Z1', 'call-Z1', 'shell', { cmd: 'echo hi' })
    session.pushToolCall('call-Z1', 'shell', { cmd: 'echo hi' })
    // 故意插入多条无关事件，让调用与结果相隔多步（§8 反例：不能靠相邻推断配对）
    session.pushUser('中间的一条无关消息甲' + '甲'.repeat(30))
    session.pushAssistant('中间的一条无关回答乙' + '乙'.repeat(30))
    session.pushUser('中间的一条无关消息丙' + '丙'.repeat(30))
    session.pushToolResult('call-Z1', '配对结果正文-Z1')
    session.pushAssistant('收尾回答')
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const ids = (await engine.recordIdsOf(session.id)).ids
    const reads = new Map()
    for (const id of ids) reads.set(id, await engine.toolRead(session.id, id, { detail: 'full' }))

    const callRecord = [...reads.values()].find((read) => read.status === 'ok' && /工具调用 shell/.test(read.text ?? ''))
    const resultRecord = [...reads.values()].find((read) => read.status === 'ok' && /配对结果正文-Z1/.test(read.text ?? ''))
    assert.ok(callRecord !== undefined && resultRecord !== undefined, '夹具必须同时有调用与结果记录')

    const callPair = callRecord.related.find((ref) => ref.relation === 'call-pair')
    assert.ok(callPair !== undefined, '调用记录必须给出配对结果（跨多步）')
    assert.equal(callPair.status, 'ok')
    assert.equal(callPair.call_id, 'call-Z1')
    assert.equal(callPair.id, resultRecord.id, '配对的必须是同 callId 的结果记录，不是相邻记录')

    const backPair = resultRecord.related.find((ref) => ref.relation === 'call-pair')
    assert.ok(backPair !== undefined, '结果记录必须能回到调用侧')
    assert.equal(backPair.call_id, 'call-Z1')
    assert.ok([callRecord.id, ...ids].includes(backPair.id))

    // 相邻关系的措辞：只表示日志相邻，绝不推断因果
    for (const ref of [...callRecord.related, ...resultRecord.related]) {
      if (ref.relation !== 'adjacent') continue
      assert.match(ref.detail, /非因果/, '相邻引用必须自带「非因果」说明')
      assert.doesNotMatch(ref.detail, /因为|导致|所以/, '相邻不得被包装成因果')
    }
    // 不相邻的两条记录不会被硬凑成配对：中间消息没有 call-pair
    const middle = [...reads.values()].find((read) => /无关消息甲/.test(read.text ?? ''))
    assert.ok(middle !== undefined)
    assert.equal(middle.related.filter((ref) => ref.relation === 'call-pair').length, 0)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('超长正文多页 + 引用分页：每页有界、offset 自洽、游标可续读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-bounds-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-bounds' }))
    const LONG = '超长正文节选甲'.repeat(1) + '甲'.repeat(19000)
    session.pushUser(LONG)
    session.pushAssistant('短回答')
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const target = (await engine.recordIdsOf(session.id)).ids
    let longId = null
    for (const id of target) {
      const read = await engine.toolRead(session.id, id, { detail: 'full', length: 100 })
      if ((read.text ?? '').includes('超长正文节选甲')) longId = id
    }
    assert.ok(longId !== null)

    // —— 正文分页：拼回全文、每页 ≤ READBACK_MAX_CHARS、offset 严格前进、cursor 版本化 ——
    let cursor = null
    let collected = ''
    let pages = 0
    let lastOffset = -1
    while (true) {
      const read = await engine.toolRead(session.id, longId, { detail: 'full', cursor })
      assert.equal(read.status, 'ok', JSON.stringify(read))
      assert.ok(read.returned_chars <= READBACK_MAX_CHARS, '单页正文不得超过 READBACK_MAX_CHARS')
      assert.equal([...(read.text ?? '')].length, read.returned_chars, 'returned_chars 必须与正文码点数一致')
      assert.ok(read.offset > lastOffset, '续读必须严格前进（不得原地踏步）')
      lastOffset = read.offset
      collected += read.text
      pages += 1
      if (!read.truncated) {
        assert.equal(read.next_cursor, null)
        break
      }
      assert.match(read.next_cursor, /^v1\./, '读游标必须是版本化 v1.* 形态（C-M-04）')
      assert.equal(read.cursor_version, 1)
      cursor = read.next_cursor
      assert.ok(pages < 10, '分页必须收敛')
    }
    assert.equal(collected, LONG, '多页拼回必须逐字等于原文（码点语义）')
    assert.ok(pages >= 3, '两万码点至少要分三页')

    // —— 渲染上界：正文 + 引用区 + 提示语都算进去，仍有可断言上界 ——
    const tools = createMemoryContextTools({ engine })
    const readTool = tools.find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.read)
    const firstPage = await engine.toolRead(session.id, longId, { detail: 'full' })
    const rendered = readTool.output.render({}, firstPage)[0].text
    const renderBound = READBACK_MAX_CHARS + READ_REFS_LIMITS.pageMax * 260 + 2400
    assert.ok(rendered.length < renderBound, '单次读取的渲染总长必须有上界（得到 ' + rendered.length + '）')
    assert.match(rendered, /引用区：/)
    assert.match(rendered, /命令面 \/memory-lab read/, 'render 必须诚实提示命令面 8000 字不分页')
    assert.match(rendered, /码点/, 'render 必须说明偏移单位')

    // —— 引用分页：一次只给一页，游标可续，页间不重复 ——
    const firstRefs = await engine.toolRead(session.id, longId, { detail: 'full', refsLimit: 1 })
    const shown = firstRefs.sources.length + firstRefs.related.length
    assert.ok(shown <= 1, 'refs_limit 必须真的限制本页引用条数')
    assert.ok(firstRefs.refs_total >= shown)
    if (firstRefs.refs_truncated) {
      assert.match(firstRefs.next_refs_cursor, /^v1\./)
      const secondPage = await engine.toolRead(session.id, longId, { detail: 'full', refsLimit: 1, refsCursor: firstRefs.next_refs_cursor })
      assert.equal(secondPage.status, 'ok', JSON.stringify(secondPage))
      const firstKeys = new Set([...firstRefs.sources, ...firstRefs.related].map((ref) => ref.relation + '|' + ref.id))
      for (const ref of [...secondPage.sources, ...secondPage.related]) {
        assert.equal(firstKeys.has(ref.relation + '|' + ref.id), false, '引用页之间不得重复（序号前进）')
      }
    }
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
