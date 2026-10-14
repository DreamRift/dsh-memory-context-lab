/**
 * v2 检索层测试：多路检索合并、来源标注、增量索引、来源关系。
 * 后端用假实现（不启真实灵枢、不启 Python 子进程）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import {
  RETRIEVAL_SOURCES,
  assertBackendContract,
  describeRecordRelations,
  readRetrievalIndex,
  searchRecords,
  syncRetrievalIndex,
} from '../src/v2/retrieval.mjs'

const SESSION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2ret-${name}-`))
  await ensureLabRoot(root)
  return root
}

function literalMatcher(entry, needle) {
  const haystack = [entry.id, entry.kind, entry.refs?.toolName, entry.refs?.callId, entry.inline?.range]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/** 假语义后端：按给定词表命中，返回自己的外部 ID。 */
function fakeBackend({ name = 'fake-lingshu', hitsByWord = {} } = {}) {
  const indexed = []
  return {
    name,
    indexed,
    async index(records) {
      indexed.push(...records.map((record) => record.id))
      const externalIds = {}
      for (const record of records) externalIds[record.id] = `${name}:${record.id}`
      return { externalIds }
    },
    async query(text, { limit } = {}) {
      const words = Object.keys(hitsByWord)
      const matchedWords = words.filter((word) => String(text).toLowerCase().includes(word.toLowerCase()))
      const ids = matchedWords.flatMap((word) => hitsByWord[word])
      return ids.slice(0, limit ?? 20).map((id) => ({ id, score: 0.99 }))
    },
  }
}

async function seed(root, count) {
  const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
  const txn = await store.openTransaction()
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const callId = `call-${index}`
    const staged = await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_CALL,
      seq: index * 2 + 1,
      inline: { range: `${index * 2 + 1}-${index * 2 + 2}` },
      refs: { callId, messageId: `msg-${index}`, toolName: index === 0 ? 'read' : 'bash', blockIndex: 0 },
      content: `内容 ${index}`,
    }))
    ids.push(staged.id)
  }
  await store.commitTransaction(txn)
  return { store, ids }
}

test('后端契约：缺 name/index/query 一律拒绝，不静默降级', () => {
  assert.throws(() => assertBackendContract(null), (error) => error.code === 'ERETRIEVALBACKEND')
  assert.throws(() => assertBackendContract({}), (error) => error.code === 'ERETRIEVALBACKEND')
  assert.throws(() => assertBackendContract({ name: 'x' }), (error) => error.code === 'ERETRIEVALBACKEND')
  assert.throws(() => assertBackendContract({ name: 'x', index() {} }), (error) => error.code === 'ERETRIEVALBACKEND')
  const ok = fakeBackend()
  assert.equal(assertBackendContract(ok), ok)
})

test('多路检索：字面与语义命中合并去重，标注来源且不透出分数', async () => {
  const root = await makeLabRoot('merge')
  try {
    const { store, ids } = await seed(root, 3)
    try {
      const backend = fakeBackend({ hitsByWord: { call: [ids[2]] } })
      await syncRetrievalIndex({ directory: store.directory, backend, store })

      // 'read' 只命中字面（第 0 条）；'call' 命中语义（第 2 条）。
      const found = await searchRecords({
        store,
        backend,
        text: 'read',
        limit: 10,
        literalMatcher,
      })
      assert.equal(found.records.length, 1)
      assert.deepEqual(found.records[0].sources, [RETRIEVAL_SOURCES.INDEX])
      assert.equal(found.semanticUsed, true)

      const semanticOnly = await searchRecords({ store, backend, text: 'call-2', limit: 10, literalMatcher })
      assert.ok(semanticOnly.records.some((record) => record.id === ids[2]))
      const hit = semanticOnly.records.find((record) => record.id === ids[2])
      assert.ok(hit.sources.includes(RETRIEVAL_SOURCES.SEMANTIC))
      // 分数不得出现在结果里（检索分数不是置信度）。
      assert.equal(JSON.stringify(semanticOnly).includes('0.99'), false)
      assert.equal(JSON.stringify(semanticOnly).includes('score'), false)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未注入后端时只走字面匹配，并如实标注没有语义路', async () => {
  const root = await makeLabRoot('literal')
  try {
    const { store } = await seed(root, 2)
    try {
      const found = await searchRecords({ store, backend: null, text: 'bash', limit: 10, literalMatcher })
      assert.equal(found.semanticUsed, false)
      assert.equal(found.semanticError, null)
      assert.deepEqual(found.sources, [RETRIEVAL_SOURCES.INDEX])
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('语义后端失败时降级为字面结果并带出原因，不整体报错', async () => {
  const root = await makeLabRoot('degrade')
  try {
    const { store } = await seed(root, 2)
    try {
      const broken = {
        name: 'broken',
        async index() { return {} },
        async query() { throw new Error('子进程不可用') },
      }
      const found = await searchRecords({ store, backend: broken, text: 'bash', limit: 10, literalMatcher })
      assert.ok(found.records.length >= 1)
      assert.equal(found.semanticUsed, false)
      assert.match(found.semanticError, /子进程不可用/)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('增量索引：第二次同步只处理新增，换后端则从零重建并如实报告', async () => {
  const root = await makeLabRoot('incremental')
  try {
    const { store } = await seed(root, 3)
    try {
      const backend = fakeBackend()
      const first = await syncRetrievalIndex({ directory: store.directory, backend, store })
      assert.equal(first.indexedNow, 3)
      assert.equal(first.rebuilt, true)

      const second = await syncRetrievalIndex({ directory: store.directory, backend, store })
      assert.equal(second.indexedNow, 0, '已索引的记录不得重复推送')
      assert.equal(second.rebuilt, false)
      assert.equal(backend.indexed.length, 3)

      // 追加一条后只推新增那一条。
      const txn = await store.openTransaction()
      const staged = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_CALL,
        seq: 99,
        inline: { range: '99-100' },
        refs: { callId: 'call-new', messageId: 'msg-new', toolName: 'grep', blockIndex: 0 },
        content: '新内容',
      }))
      await store.commitTransaction(txn)
      const third = await syncRetrievalIndex({ directory: store.directory, backend, store })
      assert.equal(third.indexedNow, 1)
      assert.equal(backend.indexed.length, 4)
      assert.equal(third.indexedTotal, 4)

      // 换后端：记账作废，从零重建。
      const other = fakeBackend({ name: 'other-backend' })
      const fourth = await syncRetrievalIndex({ directory: store.directory, backend: other, store })
      assert.equal(fourth.rebuilt, true)
      assert.equal(fourth.indexedNow, 4)

      // 记账文件是结构化的、可被外部读取核验。
      const raw = JSON.parse(await readFile(path.join(store.directory, 'retrieval-index.json'), 'utf8'))
      assert.equal(raw.backend, 'other-backend')
      assert.equal(raw.indexed[staged.id], `other-backend:${staged.id}`)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('索引记账被篡改成陌生 schema 时视为未索引，不采信坏记账', async () => {
  const root = await makeLabRoot('badindex')
  try {
    const { store } = await seed(root, 2)
    try {
      await writeFile(path.join(store.directory, 'retrieval-index.json'), JSON.stringify({
        kind: 'some-other-plugin/index',
        schemaVersion: 99,
        backend: 'x',
        indexed: { 't00000001-r0001': 'external' },
      }), 'utf8')
      assert.equal(await readRetrievalIndex(store.directory), null)
      const backend = fakeBackend()
      const synced = await syncRetrievalIndex({ directory: store.directory, backend, store })
      assert.equal(synced.indexedNow, 2, '坏记账不得让记录被跳过')
      assert.equal(synced.rebuilt, true)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('来源关系：只报配对、fork 与索引外部 ID，不做语义推断', async () => {
  const root = await makeLabRoot('relations')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    try {
      const txn = await store.openTransaction()
      const call = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_CALL,
        seq: 1,
        inline: { range: '1-2' },
        refs: { callId: 'call-pair', messageId: 'msg-1', toolName: 'read', blockIndex: 0 },
        content: '{"file":"a"}',
      }))
      const result = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: 2,
        inline: { range: '1-2' },
        refs: { callId: 'call-pair', resultMessageId: 'msg-2' },
        content: '结果',
      }))
      await store.commitTransaction(txn)

      const backend = fakeBackend()
      await syncRetrievalIndex({ directory: store.directory, backend, store })
      const index = await readRetrievalIndex(store.directory)

      const described = describeRecordRelations({
        store,
        recordId: call.id,
        forkMap: { mapping: { [call.id]: 't00000009-r0001' } },
        retrievalIndex: index,
        backendName: backend.name,
      })
      const kinds = described.relations.map((relation) => `${relation.kind}/${relation.relation}`)
      assert.ok(kinds.includes('pairing/call/result'))
      // fork 映射方向是「父 → 子」：本条是父，应报 migrated-to-child。
      assert.ok(kinds.includes('fork/migrated-to-child'))
      assert.ok(kinds.includes('index/indexed-as'))
      // 反向：子记录应报 inherited-from-parent。
      const child = describeRecordRelations({
        store,
        recordId: result.id,
        forkMap: { mapping: { [call.id]: result.id } },
      })
      assert.ok(child.relations.some((relation) => relation.relation === 'inherited-from-parent' && relation.recordId === call.id))
      // 结果记录侧也要能看到配对来源。
      const back = describeRecordRelations({ store, recordId: result.id })
      assert.ok(back.relations.some((relation) => relation.recordId === call.id && relation.callId === 'call-pair'))
      // 未知 ID 如实失败。
      assert.throws(
        () => describeRecordRelations({ store, recordId: 't00000001-r9999' }),
        (error) => error.code === 'EREADNOTFOUND',
      )
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('检索词为空或缺少字面匹配器时显式拒绝，不返回空结果冒充成功', async () => {
  const root = await makeLabRoot('guard')
  try {
    const { store } = await seed(root, 1)
    try {
      await assert.rejects(
        () => searchRecords({ store, text: '   ', limit: 5, literalMatcher }),
        (error) => error.code === 'EINVAL',
      )
      await assert.rejects(
        () => searchRecords({ store, text: 'x', limit: 5 }),
        (error) => error.code === 'EINVAL',
      )
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('检索不越过本会话隔离根：另一会话的记录不会出现在结果里', async () => {
  const root = await makeLabRoot('isolation')
  try {
    const first = await seed(root, 1)
    first.store.close()
    // 第二个会话自己的库。
    const otherSession = 'ffffffffffffffffffffffff'
    const other = await V2SessionStore.init({ labRoot: root, sessionId: otherSession })
    const txn = await other.openTransaction()
    await other.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_CALL,
      seq: 1,
      inline: { range: '1-2' },
      refs: { callId: 'call-other', messageId: 'msg-other', toolName: 'bash', blockIndex: 0 },
      content: '别的会话',
    }))
    await other.commitTransaction(txn)
    try {
      const found = await searchRecords({ store: other, text: 'call-other', limit: 10, literalMatcher })
      assert.equal(found.records.length, 1)
      // 只查自己目录：不是靠 session 字段过滤，而是两个隔离根本来就不通。
      assert.equal(found.records[0].entry.refs.callId, 'call-other')
      assert.notEqual(sessionKeyFor(SESSION_ID), sessionKeyFor(otherSession))
    } finally {
      other.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── D4：插件来源记录不进检索索引，命中侧同样过滤 ─────────────────────────────

import { recordsFromEvent } from '../src/v2/records.mjs'
import { isPluginAuthoredEntry, pluginAuthoredBody } from '../src/v2/retrieval.mjs'
import { createV2ClientFactory } from '../src/v2/client-adapter.mjs'
import { PACKAGE_NAME, PLUGIN_SOURCE_FORMS, RECEIPT_MARKER, V2_RECEIPT_MARKER } from '../src/core.mjs'
import { CARD_HEADER } from '../src/v2/working-state.mjs'

/** D4 判定单元：ingest 的作者标记覆盖新写入三类插件形态与人类消息。 */
test('D4 ingest：插件来源 user/message 记录带 pluginAuthored，人类消息与旧回执兜底都判得对', () => {
  const pluginCard = recordsFromEvent({
    type: 'user/message',
    seq: 7,
    data: {
      id: 'card-1',
      source: { kind: PACKAGE_NAME, form: PLUGIN_SOURCE_FORMS.WORKING_SET },
      content: [{ type: 'text', text: `${CARD_HEADER}\n- 进度 t…-r… 状态 result-visible` }],
    },
  })
  assert.equal(pluginCard.length, 1)
  assert.equal(pluginCard[0].inline.pluginAuthored, true, '新写入的插件卡片必须带 pluginAuthored')

  const legacyReceipt = recordsFromEvent({
    type: 'user/message',
    seq: 8,
    data: {
      id: 'rcpt-1',
      // 旧日志的回执：source.kind 是 'user'、无 form，只能靠正文标记辨认。
      source: { kind: 'user' },
      content: [{ type: 'text', text: `${RECEIPT_MARKER}\n片段：用户消息\n…` }],
    },
  })
  assert.equal(legacyReceipt[0].inline.pluginAuthored, true, '旧回执（正文标记）必须判为插件来源')

  const human = recordsFromEvent({
    type: 'user/message',
    seq: 9,
    data: {
      id: 'human-1',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '帮我把这段历史检索的口径统一起来。' }],
    },
  })
  assert.equal(human[0].inline.pluginAuthored, undefined, '人类消息不得带 pluginAuthored')

  // 判定函数对已落库形态（目录条目）同样成立。
  assert.equal(isPluginAuthoredEntry({ inline: { pluginAuthored: true } }), true)
  assert.equal(isPluginAuthoredEntry({ inline: {} }), false)
  assert.equal(isPluginAuthoredEntry(null), false)
  // 正文前缀兜底：四种插件形态都命中，人类正文不命中。
  assert.equal(pluginAuthoredBody(`${CARD_HEADER}\n…`), true)
  assert.equal(pluginAuthoredBody(`${RECEIPT_MARKER}\n…`), true)
  assert.equal(pluginAuthoredBody(`${V2_RECEIPT_MARKER}\n…`), true)
  assert.equal(pluginAuthoredBody('以下是本会话隔离冷库中的【已归档操作】节选…'), true)
  assert.equal(pluginAuthoredBody('帮我把这段历史检索的口径统一起来。'), false)

  console.log('[D4 ingest] 卡片/旧回执→pluginAuthored=true；人类消息→无标记；正文兜底四种形态全命中')
})

/** D4 索引同步侧：插件记录不交给后端，旧形态靠正文前缀兜底，人类消息照常索引。 */
test('D4 索引同步：插件来源记录不进检索索引（inline 标记 + 旧正文兜底），人类与工具记录照常', async () => {
  const root = await makeLabRoot('d4sync')
  try {
    const { store, ids } = await seed(root, 1)
    try {
      const txn = await store.openTransaction()
      // 新写入的插件卡片 ingest 记录（inline.pluginAuthored）。
      const pluginTurn = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.TURN_USER,
        seq: 2,
        inline: { pluginAuthored: true },
        refs: { messageId: 'card-1', rpcId: null },
        content: `${CARD_HEADER}\n- 进度`,
      }))
      // 修复前已提交的旧形态归档 span：无 inline 标记，正文是卡片头。
      const legacyCardSpan = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.PROJECTION_SPAN,
        seq: 0,
        fidelity: 'synthesized',
        refs: { sourceKinds: 'turn.user', sourceSeqs: '7', spanKind: 'turn.user' },
        inline: { nodeId: 'archived_x_1', range: { start: 7, end: 7 }, tools: null, callIds: null },
        content: `${CARD_HEADER}\n- 一张旧卡片`,
      }))
      // 人类消息 ingest 记录：无标记、正文普通——必须照常索引（防误杀）。
      const humanTurn = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.TURN_USER,
        seq: 3,
        refs: { messageId: 'human-1', rpcId: null },
        content: '帮我把这段历史检索的口径统一起来。',
      }))
      await store.commitTransaction(txn)

      const backend = fakeBackend()
      const synced = await syncRetrievalIndex({ directory: store.directory, backend, store })
      assert.equal(synced.excludedPluginAuthored, 2, '插件卡片（inline 标记）+ 旧卡片 span（正文兜底）都不得进索引')
      assert.ok(synced.excludedPluginAuthoredIds.includes(pluginTurn.id))
      assert.ok(synced.excludedPluginAuthoredIds.includes(legacyCardSpan.id))
      // 后端只收到工具记录与人类消息。
      assert.deepEqual([...backend.indexed].sort(), [humanTurn.id, ids[0]].sort())
      // 被排除的记录不写进 indexed 记账（不是「已索引」）。
      const index = await readRetrievalIndex(store.directory)
      assert.equal(index.indexed[pluginTurn.id], undefined)
      assert.equal(index.indexed[legacyCardSpan.id], undefined)
      assert.ok(index.indexed[humanTurn.id])

      console.log(`[D4 索引同步] 后端收到 ${backend.indexed.length} 条（工具+人类），排除插件来源 ${synced.excludedPluginAuthored} 条且不入记账`)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** D4 命中侧：字面命中与语义换回（旧索引残留）都过滤插件来源记录。 */
test('D4 命中过滤：字面与语义两路都不得把插件来源记录放进结果', async () => {
  const root = await makeLabRoot('d4hit')
  try {
    const { store, ids } = await seed(root, 1)
    try {
      const txn = await store.openTransaction()
      const pluginTurn = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.TURN_USER,
        seq: 2,
        inline: { pluginAuthored: true },
        refs: { messageId: 'card-1', rpcId: null },
        content: `${CARD_HEADER}\n- 进度`,
      }))
      await store.commitTransaction(txn)

      // 字面路：matcher 咬得到插件记录（按 id 命中），但结果里不得出现。
      const literalHit = await searchRecords({
        store,
        backend: null,
        text: pluginTurn.id,
        limit: 10,
        literalMatcher,
      })
      assert.equal(literalHit.records.length, 0, '插件来源记录不得出现在字面命中里')

      // 语义路：模拟旧索引残留——把插件记录的外部 ID 写进记账，后端 query 返回它。
      await writeFile(path.join(store.directory, 'retrieval-index.json'), JSON.stringify({
        kind: 'dsh-memory-context-lab/v2/retrieval-index',
        schemaVersion: 1,
        backend: 'fake-lingshu',
        indexed: { [pluginTurn.id]: `fake-lingshu:${pluginTurn.id}` },
      }), 'utf8')
      const backend = fakeBackend({ hitsByWord: { card: [`fake-lingshu:${pluginTurn.id}`] } })
      const semanticHit = await searchRecords({
        store,
        backend,
        text: 'card',
        limit: 10,
        literalMatcher,
      })
      assert.ok(!semanticHit.records.some((record) => record.id === pluginTurn.id), '语义换回的插件记录必须被过滤')

      // 防误杀：普通工具记录在同一后端下照常命中（字面）。
      const toolHit = await searchRecords({ store, backend: null, text: ids[0], limit: 10, literalMatcher })
      assert.equal(toolHit.records.length, 1)

      console.log(`[D4 命中过滤] 字面 0 命中（插件记录被滤）、语义 ${semanticHit.records.length} 命中（插件被滤）、工具记录照常 ${toolHit.records.length} 命中`)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** D4 回注面：插件卡片 span 不进回注候选（含 recency 兜底），label 按作者区分。 */
test('D4 回注面：插件来源 span 不被回注，也不再渲染成「用户消息」', async () => {
  const root = await makeLabRoot('d4recall')
  try {
    const factory = createV2ClientFactory({ labRoot: root, sessionId: SESSION_ID, backendFor: () => null })
    const client = await factory.createClient()
    try {
      // 归档两条同形 span：一条插件卡片（作者标记随单元落库），一条人类消息。
      const card = await client.rememberArchived({
        nodeId: 'archived_card_1',
        text: `${CARD_HEADER}\n- 进度 t00000001-r0001 状态 result-visible`,
        range: { start: 7, end: 7 },
        tools: [],
        callIds: [],
        spanKind: 'turn.user',
        pluginAuthored: true,
      })
      const human = await client.rememberArchived({
        nodeId: 'archived_human_1',
        text: '帮我把这段历史检索的口径统一起来。',
        range: { start: 9, end: 9 },
        tools: [],
        callIds: [],
        spanKind: 'turn.user',
        pluginAuthored: false,
      })
      assert.equal(card.ok, true)
      assert.equal(human.ok, true)

      // 无查询词：recency 兜底只取人类 span，插件卡被排除且如实计数。
      const recalled = await client.recall('', null, 5)
      assert.equal(recalled.excludedPluginAuthored, 1, '插件卡片 span 必须被排除出回注面')
      assert.equal(recalled.hits.length, 1, '人类消息 span 照常可回注（防误杀）')
      assert.match(recalled.hits[0].content, /已归档用户消息 archived_human_1/, '人类消息的标签保持「用户消息」')

      // 修复前已落库的旧卡片 span（无 inline 标记、正文是卡片头）同样被正文兜底排除。
      const legacy = await client.rememberArchived({
        nodeId: 'archived_card_2',
        text: `${V2_RECEIPT_MARKER}\n片段：插件工作资料\n…`,
        range: { start: 11, end: 11 },
        tools: [],
        callIds: [],
        spanKind: 'turn.user',
        pluginAuthored: false,
      })
      assert.equal(legacy.ok, true)
      const recalledAgain = await client.recall('口径', null, 5)
      assert.ok(!recalledAgain.hits.some((hit) => hit.content.includes('archived_card_2')), '旧形态（回执正文）靠前缀兜底排除')
      assert.ok(recalledAgain.hits.some((hit) => hit.content.includes('archived_human_1')), '人类消息命中不受影响')

      console.log(`[D4 回注面] 排除插件来源 ${recalledAgain.excludedPluginAuthored} 条；人类 span 标签「用户消息」，插件侧不冒充`)
    } finally {
      await client.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
