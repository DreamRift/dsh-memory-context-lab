/**
 * G2 故障注入：引用链与读游标的失败面（0.15.0；§8 反例清单逐条落地）。
 *
 * 这份套件只证明「失败时**明确报错/明确标状态**，不静默成功、不泄露正文」：
 * 1. 旧回执/旧摘要没有引用 → 标未知、不补造关系（不把内联短摘要当摘要工件）；
 * 2. summary supersedes 环与自指 → 只展开一跳，循环终止；
 * 3. 坏哈希 / 缺源 / 跨会话 ID → 逐跳核验后标 hash-mismatch / missing / session-mismatch；
 * 4. 读取中 forget → 正文、摘要与来源元数据一起消失；
 * 5. 部分工具对（只有调用没有结果）→ unpaired，不假装配对；
 * 6. 读游标：旧裸数字、被篡改、版本不符、换对象、换会话、内容已变、重启后继续/显式 stale；
 * 7. 引用区上界：分页可续、编目封顶时明说 capped（不静默遗失）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createMemoryContextTools } from '../src/v3/entry/tools.mjs'
import { MEMORY_CONTEXT_TOOL_NAMES } from '../src/v3/contracts/tools.mjs'
import { READ_REFS_LIMITS } from '../src/v3/contracts/citations.mjs'
import { buildSummaryArtifact, sourceSetMaterial } from '../src/v3/domain/compress/summary-artifact.mjs'
import { appendSummary, summariesPath } from '../src/v3/adapters/storage/summary-store.mjs'
import { encodeReadCursor } from '../src/v3/domain/readback/read-cursor.mjs'
import { capCitations, dedupeCitations, paginateCitations } from '../src/v3/domain/readback/citations.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const sha256 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')

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

function withEvents(session) {
  session.events = () => session.log
  return session
}

async function mount(root) {
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  return { ctx, engine }
}

/** 单会话数据目录（装配点把 session id 变成隔离键，测试只能从磁盘反查）。 */
async function sessionDirOf(root) {
  const keys = await readdir(path.join(root, 'sessions'))
  assert.equal(keys.length, 1, '夹具必须只有一个会话目录')
  return path.join(root, 'sessions', keys[0])
}

async function sessionKeyOf(root) {
  const directory = await sessionDirOf(root)
  const files = await readdir(directory)
  assert.ok(files.includes('manifest.json'), '会话目录必须有 manifest.json')
  return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).sessionKey
}

let craftedCounter = 0
/** 手工落一条 SummaryArtifact（模拟旧数据/损坏数据；写路径仍走 appendSummary 的不可变追加）。 */
async function appendCrafted({ root, sessionKey, sources, supersedes = null, shortText = '手工摘要-ZQ7', detail = '手工摘要详细正文-ZQ7' }) {
  craftedCounter += 1
  const directory = await sessionDirOf(root)
  const artifact = buildSummaryArtifact({
    summaryId: 'v3s-' + craftedCounter.toString(16).padStart(16, '0'),
    sessionKey,
    sources,
    generator: 'extractive',
    generatorVersion: 'extractive-v1',
    draft: { shortText, detail },
    createdAt: Date.now() + craftedCounter,
    sourceSetFingerprint: sha256(sourceSetMaterial(sources)),
    supersedes,
  })
  const written = await appendSummary(directory, artifact)
  assert.equal(written.appended, true, JSON.stringify(written))
  return artifact
}

test('旧数据兼容：普通回执没有摘要工件、旧摘要没有证据引用 → 标未知，不补造关系', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-old-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-old' }))
    session.pushUser('旧数据原文-U7'.repeat(30))
    session.pushAssistant('旧数据回答-A7'.repeat(30))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.summaryId, null)

    const recordRead = await engine.toolRead(session.id, archived.recordIds[0], { detail: 'full' })
    assert.equal(recordRead.status, 'ok')
    assert.equal(recordRead.related.filter((ref) => ref.relation === 'segment-summary').length, 0,
      '普通回执没有 SummaryArtifact：不得出现 segment-summary')
    assert.match(recordRead.related.find((ref) => ref.relation === 'archive-receipt').detail, /没有 SummaryArtifact/)

    // 旧摘要（无 evidenceRefs）：来源仍核验，但不出现证据关系
    const sessionKey = await sessionKeyOf(root)
    const sourceId = archived.recordIds[0]
    const read0 = await engine.toolRead(session.id, sourceId, { detail: 'full' })
    const crafted = await appendCrafted({
      root,
      sessionKey,
      sources: [{ recordId: sourceId, hash: read0.source_hash }],
    })
    const summaryRead = await engine.toolRead(session.id, crafted.summaryId, { detail: 'short' })
    assert.equal(summaryRead.status, 'ok', JSON.stringify(summaryRead))
    assert.deepEqual(summaryRead.evidence_refs, [], '没有证据引用时不得凭空造 evidence')
    assert.equal(summaryRead.related.filter((ref) => ref.relation === 'evidence').length, 0)
    assert.equal(summaryRead.sources.length, 1)
    assert.equal(summaryRead.sources[0].status, 'ok')

    // 引用区为空时的渲染措辞：未知 ≠ 没有，且不补造（render 是值的纯函数，用真实结果改字段验证）
    const readTool = createMemoryContextTools({ engine }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.read)
    const emptyRefs = { ...recordRead, sources: [], related: [], evidence_refs: [], refs_total: 0, refs_truncated: false, refs_capped: false, next_refs_cursor: null }
    const rendered = readTool.output.render({}, emptyRefs)[0].text
    assert.match(rendered, /引用区：没有可列的引用/)
    assert.match(rendered, /不补造关系/)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('summary supersedes 环与自指：只展开一跳（环终止）、自指被显式拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-cycle-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-cycle' }))
    session.pushUser('环测试原文'.repeat(30))
    session.pushAssistant('环测试回答'.repeat(30))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)
    const sessionKey = await sessionKeyOf(root)
    const ids = (await engine.recordIdsOf(session.id)).ids
    const sourceId = ids[0]
    const sourceRead = await engine.toolRead(session.id, sourceId, { detail: 'full' })
    const sources = [{ recordId: sourceId, hash: sourceRead.source_hash }]

    const a = await appendCrafted({ root, sessionKey, sources, shortText: '摘要A' })
    const b = await appendCrafted({ root, sessionKey, sources, supersedes: a.summaryId, shortText: '摘要B' })
    // 环：把 A 改成 supersedes B —— 摘要不可变，所以再造一条 A2 形成 A2↔B 的环。
    const a2 = await appendCrafted({ root, sessionKey, sources, supersedes: b.summaryId, shortText: '摘要A2' })

    const readB = await engine.toolRead(session.id, b.summaryId, { detail: 'short' })
    assert.equal(readB.status, 'ok', JSON.stringify(readB))
    const supersedes = readB.related.find((ref) => ref.relation === 'supersedes')
    assert.ok(supersedes !== undefined)
    assert.equal(supersedes.id, a.summaryId)
    assert.equal(supersedes.status, 'ok')
    assert.equal(readB.refs_total <= READ_REFS_LIMITS.total, true, '引用条数有界')
    // 只展开一跳：B 的引用里不会继续出现 A 的 supersedes（环不会把链条铺开）
    assert.equal(readB.related.some((ref) => ref.id === a2.summaryId), false, '一跳之外不得展开')

    const readA2 = await engine.toolRead(session.id, a2.summaryId, { detail: 'short' })
    assert.equal(readA2.status, 'ok')
    assert.equal(readA2.related.find((ref) => ref.relation === 'supersedes').id, b.summaryId)

    // 自指（旧/损坏数据）：读侧校验直接拒绝（supersedes 不得指向自身），显式失败而非空白成功，
    // 也不进入「无限展开」——校验先于任何引用编目。
    const selfId = 'v3s-' + 'deadbeefdeadbeef'
    const selfArtifact = buildSummaryArtifact({
      summaryId: selfId,
      sessionKey,
      sources,
      generator: 'extractive',
      generatorVersion: 'extractive-v1',
      draft: { shortText: '自指摘要', detail: '自指摘要正文' },
      createdAt: Date.now() + 99,
      sourceSetFingerprint: sha256(sourceSetMaterial(sources)),
      supersedes: null,
    })
    // buildSummaryArtifact 禁止自指（写路径的护栏），这里**绕过构造器**直接落一行损坏数据。
    const directory = await sessionDirOf(root)
    const broken = { ...selfArtifact, supersedes: selfId }
    const { appendFile } = await import('node:fs/promises')
    await appendFile(summariesPath(directory), JSON.stringify(broken) + '\n', 'utf8')
    const readSelf = await engine.toolRead(session.id, selfId, { detail: 'short' })
    assert.equal(readSelf.status, 'failed', JSON.stringify(readSelf))
    assert.equal(readSelf.error, 'summary-invalid', '自指摘要必须显式失败（不是空白成功）')
    assert.equal(readSelf.text, null)
    assert.deepEqual(readSelf.sources, [], '非法摘要不得带出来源元数据')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('坏哈希 / 缺源 / 跨会话 ID：逐跳核验给具体状态，不泄露正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-integrity-'))
  const { ctx, engine } = await mount(root)
  try {
    const sessionA = withEvents(createFakeSession({ id: 'session-g2-int-a' }))
    sessionA.pushUser('会话A原文'.repeat(30))
    sessionA.pushAssistant('会话A回答'.repeat(30))
    sessionA.pushUser('当前问题A'.repeat(5))
    await ctx.callPreStep(sessionA)
    await settle(engine)
    const sessionKeyA = await sessionKeyOf(root)
    const idsA = (await engine.recordIdsOf(sessionA.id)).ids
    const realId = idsA[0]
    const realRead = await engine.toolRead(sessionA.id, realId, { detail: 'full' })

    // 1) 坏哈希：摘要声称的来源 hash 与记录当前字节不符（指纹自洽，所以摘要本身合法可读）
    const wrongHash = 'a'.repeat(64)
    const badHash = await appendCrafted({ root, sessionKey: sessionKeyA, sources: [{ recordId: realId, hash: wrongHash }], shortText: '坏哈希摘要' })
    const badRead = await engine.toolRead(sessionA.id, badHash.summaryId, { detail: 'short' })
    assert.equal(badRead.status, 'ok', JSON.stringify(badRead))
    assert.equal(badRead.sources[0].status, 'hash-mismatch', '来源 hash 不符必须标 hash-mismatch（不是「不存在」）')
    assert.equal(badRead.sources[0].hash, realRead.source_hash, '引用上给出**实际**记录 hash，便于对账')
    assert.notEqual(badRead.sources[0].hash, wrongHash)

    // 2) 缺源：摘要引用了一个不存在的记录 ID（形状合法）
    const missingId = 'v3r-' + '0'.repeat(15) + '1'
    const missing = await appendCrafted({ root, sessionKey: sessionKeyA, sources: [{ recordId: missingId, hash: 'b'.repeat(64) }], shortText: '缺源摘要' })
    const missingRead = await engine.toolRead(sessionA.id, missing.summaryId, { detail: 'short' })
    assert.equal(missingRead.sources[0].status, 'missing')
    assert.equal(missingRead.sources[0].hash, null, '缺源不得伪造 hash')

    // 3) 跨会话：另一个会话里读 A 的记录 ID / 把 A 的摘要行拷进 B
    const dirOfA = await sessionDirOf(root)
    const sessionB = withEvents(createFakeSession({ id: 'session-g2-int-b' }))
    sessionB.pushUser('会话B原文'.repeat(30))
    sessionB.pushUser('当前问题B'.repeat(5))
    await ctx.callPreStep(sessionB)
    await settle(engine)
    const keysB = await readdir(path.join(root, 'sessions'))
    const dirOfB = path.join(root, 'sessions', keysB.find((key) => key !== path.basename(dirOfA)))
    const crossRecord = await engine.toolRead(sessionB.id, realId, { detail: 'full' })
    assert.equal(crossRecord.status, 'not-found', JSON.stringify(crossRecord))
    assert.equal(crossRecord.text, null)
    assert.deepEqual(crossRecord.sources, [], '跨会话失败不得带出来源元数据')
    // F3：不存在 ≠ 已隐藏（二值 visible 会把两种事实印成一句话，误导模型放弃重试）
    const readToolForNotFound = createMemoryContextTools({ engine }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.read)
    const notFoundRender = readToolForNotFound.output.render({}, crossRecord)[0].text
    assert.match(notFoundRender, /不存在/, 'not-found 必须印「不存在」')
    assert.doesNotMatch(notFoundRender, /已隐藏/, 'not-found 不是「已隐藏」')
    assert.doesNotMatch(notFoundRender, /没有可列的引用/, '失败态不得给出引用区事实判断')

    // 把 A 的摘要行原样拷进 B 的 summaries.jsonl（模拟导入/拷贝）
    const lineA = (await readFile(summariesPath(dirOfA), 'utf8')).trim().split('\n')[0]
    const { appendFile } = await import('node:fs/promises')
    await appendFile(summariesPath(dirOfB), lineA + '\n', 'utf8')
    const copiedId = JSON.parse(lineA).summaryId
    const crossSummary = await engine.toolRead(sessionB.id, copiedId, { detail: 'short' })
    assert.equal(crossSummary.status, 'hidden', JSON.stringify(crossSummary))
    assert.equal(crossSummary.error, 'session-mismatch')
    assert.equal(crossSummary.text, null, '跨会话摘要不得返回正文')
    assert.deepEqual(crossSummary.sources, [])
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('读取中 forget：正文、摘要与来源元数据一起消失（不泄露）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-forget-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-forget' }))
    session.pushUser('遗忘测试原文'.repeat(30))
    session.pushAssistant('遗忘测试回答'.repeat(30))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)
    const sessionKey = await sessionKeyOf(root)
    const ids = (await engine.recordIdsOf(session.id)).ids
    const sourceId = ids[0]
    const sourceRead = await engine.toolRead(session.id, sourceId, { detail: 'full' })
    const summary = await appendCrafted({ root, sessionKey, sources: [{ recordId: sourceId, hash: sourceRead.source_hash }], shortText: '遗忘前摘要' })

    const before = await engine.toolRead(session.id, summary.summaryId, { detail: 'short' })
    assert.equal(before.status, 'ok')
    assert.equal(before.sources[0].status, 'ok')
    // 记住一个正文游标（长记录才有；这里用 source 的长正文分页游标做「读取中 forget」的 stale 面）
    const paged = await engine.toolRead(session.id, sourceId, { detail: 'full', length: 10 })
    const cursor = paged.next_cursor
    assert.ok(cursor === null || cursor.startsWith('v1.'))

    const forget = await engine.forgetRecords(session.id, [sourceId])
    assert.ok(forget.error === undefined, JSON.stringify(forget))

    const recordAfter = await engine.toolRead(session.id, sourceId, { detail: 'full' })
    assert.equal(recordAfter.status, 'hidden')
    assert.equal(recordAfter.error, 'record-forgotten')
    assert.equal(recordAfter.text, null)
    assert.deepEqual(recordAfter.sources, [])
    assert.deepEqual(recordAfter.related, [])
    assert.equal(recordAfter.refs_total, 0)

    const summaryAfter = await engine.toolRead(session.id, summary.summaryId, { detail: 'short' })
    assert.equal(summaryAfter.status, 'hidden', JSON.stringify(summaryAfter))
    assert.equal(summaryAfter.error, 'forgotten-source')
    assert.equal(summaryAfter.text, null, '来源被忘后不得返回摘要正文')
    assert.deepEqual(summaryAfter.sources, [], '隐藏对象不得带出来源元数据')

    if (cursor !== null) {
      const staleRead = await engine.toolRead(session.id, sourceId, { detail: 'full', cursor })
      assert.equal(staleRead.status, 'hidden', '游标不能绕过遗忘（对象级判定先于分页）')
      assert.equal(staleRead.text, null)
    }
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('部分工具对：只有调用没有结果 → unpaired（不假装配对、也不丢引用区）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-unpaired-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-unpaired' }))
    session.pushUser('未完成对测试'.repeat(30))
    session.pushAssistantWithToolCall('要调用但没结果', 'call-OPEN', 'shell', { cmd: 'sleep 1' })
    session.pushToolCall('call-OPEN', 'shell', { cmd: 'sleep 1' })
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)
    const ids = (await engine.recordIdsOf(session.id)).ids
    let found = null
    for (const id of ids) {
      const read = await engine.toolRead(session.id, id, { detail: 'full' })
      if (read.status === 'ok' && /工具调用 shell/.test(read.text ?? '')) found = read
    }
    assert.ok(found !== null, '夹具必须有调用记录')
    const pair = found.related.find((ref) => ref.relation === 'call-pair')
    assert.ok(pair !== undefined, '未完成对也要如实给出配对状态')
    assert.equal(pair.status, 'unpaired')
    assert.equal(pair.call_id, 'call-OPEN')
    assert.match(pair.detail, /没有找到同 callId 的结果事件/)
    assert.deepEqual(found.sources, [], '记录侧没有链 B 来源')
    assert.ok(found.related.some((ref) => ref.relation === 'adjacent'), 'unpaired 不影响相邻引用')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('读游标失败矩阵（C-M-04）：旧格式/篡改/版本/换对象/换会话/内容已变/重启', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-cursor-'))
  const { ctx, engine } = await mount(root)
  let reopened = null
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-cursor' }))
    session.pushUser('游标测试超长正文'.repeat(1) + '乙'.repeat(19000))
    session.pushUser('第二条长文'.repeat(1) + '丙'.repeat(19000))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const ids = (await engine.recordIdsOf(session.id)).ids
    const longs = []
    for (const id of ids) {
      const read = await engine.toolRead(session.id, id, { detail: 'full', length: 4000 })
      if (read.returned_chars >= 4000) longs.push({ id, read })
    }
    assert.ok(longs.length >= 2, '夹具需要两条超长记录')
    const [first, second] = longs
    assert.match(first.read.next_cursor, /^v1\./)

    // 1) 旧裸数字游标：明确拒绝（旧实现会静默回第一页）
    const legacy = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: '8000' })
    assert.equal(legacy.status, 'rejected')
    assert.equal(legacy.error, 'read-cursor-legacy-format')
    assert.equal(legacy.text, null, '被拒的游标不得返回任何一页内容')
    // F3：被拒时 render 不得对「根本没读的引用区」下事实判断（"没有可列的引用"）
    const readTool = createMemoryContextTools({ engine }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.read)
    const rejectedRender = readTool.output.render({}, legacy)[0].text
    assert.match(rejectedRender, /引用区：本次未读（游标被拒）/, '被拒必须说「本次未读」，而不是「没有引用」')
    assert.doesNotMatch(rejectedRender, /没有可列的引用/, '被拒不得声称引用区为空（那是没读，不是没有）')
    assert.doesNotMatch(rejectedRender, /已隐藏/, '被拒不是「已隐藏」')

    // 2) 被篡改（校验和不符）
    const tampered = first.read.next_cursor.slice(0, -1) + (first.read.next_cursor.endsWith('0') ? '1' : '0')
    const tamperedRead = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: tampered })
    assert.equal(tamperedRead.error, 'read-cursor-invalid')
    assert.equal(tamperedRead.text, null)

    // 3) 版本不符
    const versioned = 'v2.' + first.read.next_cursor.slice(3)
    const versionRead = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: versioned })
    assert.equal(versionRead.error, 'read-cursor-version-unsupported')

    // 4) 换对象：cursor 属于另一条记录
    const otherObject = await engine.toolRead(session.id, second.id, { detail: 'full', cursor: first.read.next_cursor })
    assert.equal(otherObject.error, 'read-cursor-id-mismatch')
    assert.equal(otherObject.text, null)

    // 5) 换会话：用同一套编解码器铸一条**别的会话**的游标（同对象、同版本）
    const otherSessionCursor = encodeReadCursor({
      hash: sha256,
      sessionId: 'session-elsewhere',
      id: first.id,
      page: 'object',
      objectVersion: first.read.source_hash,
      offset: 4000,
    })
    const crossSession = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: otherSessionCursor })
    assert.equal(crossSession.error, 'read-cursor-session-mismatch', JSON.stringify(crossSession))

    // 6) 引用页游标当正文游标用：两种分页虽共用绑定/错误码，但偏移空间不同 → 显式拒绝
    const refsPageCursor = encodeReadCursor({
      hash: sha256,
      sessionId: session.id,
      id: first.id,
      page: 'refs',
      objectVersion: first.read.source_hash,
      offset: 0,
    })
    const refsCursorAsObject = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: refsPageCursor })
    assert.equal(refsCursorAsObject.error, 'read-cursor-invalid', JSON.stringify(refsCursorAsObject))
    assert.equal(refsCursorAsObject.text, null)

    // 7) 内容已变：改记录字节（text 与 bytes 同步，结构仍合法）→ 旧游标显式 stale
    const directory = await sessionDirOf(root)
    const recordFile = path.join(directory, 'records', first.id + '.json')
    const record = JSON.parse(await readFile(recordFile, 'utf8'))
    const changed = record.payload.text + '（后来改写的一段）'
    record.payload.text = changed
    record.payload.bytes = Buffer.byteLength(changed, 'utf8')
    await writeFile(recordFile, JSON.stringify(record) + '\n', 'utf8')
    const changedRead = await engine.toolRead(session.id, first.id, { detail: 'full', cursor: first.read.next_cursor })
    assert.equal(changedRead.error, 'read-cursor-object-changed', JSON.stringify(changedRead))
    assert.equal(changedRead.text, null)

    // 8) 重启后游标继续：同一对象、同一字节 → 游标仍然可验证（状态不是「静默失效」，而是继续）
    const secondId = second.id
    const secondCursor = second.read.next_cursor
    const beforeRestart = await engine.toolRead(session.id, secondId, { detail: 'full', cursor: secondCursor })
    assert.equal(beforeRestart.status, 'ok', JSON.stringify(beforeRestart))
    engine.dispose()
    const again = await mount(root)
    reopened = again.engine
    // 复用同一个假会话（日志不变）：重开只重建 runtime，不重新摄入新事件。
    await again.ctx.callPreStep(session)
    await settle(reopened)
    const afterRestart = await reopened.toolRead(session.id, secondId, { detail: 'full', cursor: secondCursor })
    assert.equal(afterRestart.status, 'ok', JSON.stringify(afterRestart))
    assert.equal(afterRestart.offset, beforeRestart.offset)
    assert.equal(afterRestart.text, beforeRestart.text, '重启后续读必须与重启前逐字一致（游标绑定内容，不绑定进程）')

    // 9) 重启后内容/对象变了 → 显式 stale（不是空白成功）
    const staleAfterRestart = await reopened.toolRead(session.id, first.id, { detail: 'full', cursor: first.read.next_cursor })
    assert.equal(staleAfterRestart.error, 'read-cursor-object-changed')
  } finally {
    try { engine.dispose() } catch {}
    if (reopened !== null) { try { reopened.dispose() } catch {} }
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('引用区上界：分页可续、编目封顶明说 capped；去重按「关系+ID」', async () => {
  // —— 纯函数层：分页/去重/封顶（不依赖 IO，可精确断言上界） ——
  const many = Array.from({ length: 300 }, (_, index) => ({ id: 'v3r-' + index.toString(16).padStart(16, '0'), kind: 'record', relation: 'source', status: 'ok' }))
  const once = dedupeCitations([...many, ...many])
  assert.equal(once.length, 300, '同一 (关系,ID) 重复项必须去重')
  const capped = capCitations(once)
  assert.equal(capped.capped, true, '超过编目上界必须显式 capped（不静默丢）')
  assert.equal(capped.items.length, READ_REFS_LIMITS.total)
  const page = paginateCitations(capped.items, { offset: 0, pageSize: 999 })
  assert.equal(page.items.length, READ_REFS_LIMITS.pageMax, '单页条数硬上界')
  assert.notEqual(page.nextOffset, null)
  const last = paginateCitations(capped.items, { offset: capped.items.length - 1, pageSize: 8 })
  assert.equal(last.nextOffset, null, '最后一页必须明确「没有更多」')

  // 同一对象既是来源又被当证据：不同关系是两个事实，不去重
  const both = dedupeCitations([
    { id: 'v3r-0000000000000001', kind: 'record', relation: 'source', status: 'ok' },
    { id: 'v3r-0000000000000001', kind: 'record', relation: 'evidence', status: 'ok' },
  ])
  assert.equal(both.length, 2)

  // —— 端到端：12 条来源的摘要按页读，页间不重复、并集等于 refs_total ——
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g2-refpage-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = withEvents(createFakeSession({ id: 'session-g2-refpage' }))
    for (let index = 0; index < 12; index += 1) session.pushUser('来源记录 ' + index + '：' + '文'.repeat(40))
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)
    const sessionKey = await sessionKeyOf(root)
    const ids = (await engine.recordIdsOf(session.id)).ids.slice(0, 12)
    assert.equal(ids.length, 12)
    const sources = []
    for (const id of ids) {
      const read = await engine.toolRead(session.id, id, { detail: 'full' })
      sources.push({ recordId: id, hash: read.source_hash })
    }
    const summary = await appendCrafted({ root, sessionKey, sources, shortText: '十二条来源的摘要' })

    const collected = new Set()
    let refsCursor = null
    let pages = 0
    while (true) {
      const read = await engine.toolRead(session.id, summary.summaryId, { detail: 'short', refsLimit: 5, refsCursor })
      assert.equal(read.status, 'ok', JSON.stringify(read))
      const shown = [...read.sources, ...read.related]
      assert.ok(shown.length <= 5, 'refs_limit 必须真的限制本页条数')
      for (const ref of shown) collected.add(ref.relation + '|' + ref.id)
      pages += 1
      if (!read.refs_truncated) {
        assert.equal(read.next_refs_cursor, null)
        break
      }
      refsCursor = read.next_refs_cursor
      assert.match(refsCursor, /^v1\./)
      assert.ok(pages < 10, '引用分页必须收敛')
    }
    assert.equal(pages, Math.ceil(12 / 5))
    assert.equal(collected.size, 12, '翻完所有引用页必须拿到全部来源（不静默遗失）')
    assert.equal(collected.size <= READ_REFS_LIMITS.total, true)

    // 引用游标也绑定对象版本：摘要内容一变（物件被改写/新版本），旧引用游标显式失效
    const firstPage = await engine.toolRead(session.id, summary.summaryId, { detail: 'short', refsLimit: 5 })
    assert.ok(typeof firstPage.next_refs_cursor === 'string')
    const directory = await sessionDirOf(root)
    const rows = (await readFile(summariesPath(directory), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const tampered = rows.map((row) => (row.summaryId === summary.summaryId ? { ...row, detail: row.detail + '（被改写）' } : row))
    await writeFile(summariesPath(directory), tampered.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    const staleRefs = await engine.toolRead(session.id, summary.summaryId, { detail: 'short', refsLimit: 5, refsCursor: firstPage.next_refs_cursor })
    assert.equal(staleRefs.status, 'rejected', JSON.stringify(staleRefs))
    assert.equal(staleRefs.error, 'read-cursor-object-changed', '引用游标与正文游标共用同一套对象版本绑定')
    assert.equal(staleRefs.text, null)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
