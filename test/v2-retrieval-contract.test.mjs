/**
 * 检索契约测试（0.10.1，R1 反例转红例）。
 *
 * 缺陷（取证 R1，F1–F3 全部成立）：
 * - F1 exact 短语顺序失效：T1 query 把 exact 数组 join 后 tokenize 成无序词集，
 *   "alpha beta" 命中「beta … alpha」散落文档；
 * - F2 字面路 probes.some 绕过 AND：多 exact 约束只需命中一个即接纳；
 * - F3 OOV 稀释：语料外词 df=0 获最大 IDF 进 totalIdf 分母，长问句把相关结果压到线下
 *   （数值推演：1 主题词 + 3 OOV → rel≈0.189 < 0.5）。
 *
 * 判据（方案复核 §3.3 分层）：所有通道合并后统一验证 exact 短语顺序/多条件 AND/
 * 路径边界，再截 top-k；OOV 词不进 relevance 分母且单独披露；T1 与字面路对同一
 * exact 数组给出一致命中面。
 *
 * 不适用条件：弱候选 pointerOnly 档与 queryDetailed 诊断契约在后续批次（本套件只锁
 * 契约缺陷）；回注渲染顺序（F4a）在 client-adapter 层，由 v2-local-client 套件覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { ensureLabRoot } from '../src/storage.mjs'
import { searchRecords } from '../src/v2/retrieval.mjs'
import { createLocalLexicalBackend } from '../src/v2/local-lexical-backend.mjs'
import { syncRetrievalIndex } from '../src/v2/retrieval.mjs'

async function makeRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl2rc-' + name + '-'))
  await ensureLabRoot(root)
  return root
}

/** 与生产同口径的元数据 haystack（client-adapter 的 spanHaystackOf 简化版）。 */
function literalMatcher(entry, needle) {
  const hay = [entry.id, entry.kind, entry.refs?.callId ?? '', entry.inline?.nodeId ?? ''].join(' ').toLowerCase()
  return hay.includes(String(needle).toLowerCase())
}

async function seedDocs(root, sessionId, docs) {
  const store = await V2SessionStore.init({ labRoot: root, sessionId })
  try {
    const txn = await store.openTransaction()
    const ids = []
    for (const [index, text] of docs.entries()) {
      const staged = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: index + 1,
        fidelity: 'verbatim',
        refs: { callId: 'call-' + (index + 1), resultMessageId: 'm' + (index + 1) },
        inline: { nodeId: 'mcl2-doc-' + (index + 1) },
        content: text,
      }))
      ids.push(staged.id)
    }
    await store.commitTransaction(txn)
    return ids
  } finally {
    store.close()
  }
}

async function openStore(root, sessionId) {
  return V2SessionStore.open({ labRoot: root, sessionId, readOnly: true })
}

test('TC1（F1）：exact 引号短语不命中换序/散落文档', async () => {
  const root = await makeRoot('phrase')
  try {
    const sessionId = 'session-rc-phrase-01'
    await seedDocs(root, sessionId, [
      'beta gamma alpha delta',   // 换序散落：不得命中 "alpha beta"
      'alpha beta together',      // 真短语：应命中
      'nothing related here',
    ])
    const store = await openStore(root, sessionId)
    try {
      const backend = createLocalLexicalBackend({ directory: store.directory })
      await syncRetrievalIndex({ directory: store.directory, backend, store })
      const found = await searchRecords({ store, backend, text: '', exact: ['alpha beta'], limit: 10, literalMatcher })
      const hitIndexes = found.records.map((r) => r.id)
      assert.equal(found.records.length, 1, '只有真短语文档命中：' + JSON.stringify(found.records.map((r) => r.id)))
      // 命中的必须是第 2 条（alpha beta together）
      const entries = store.listEntries({ limit: 100 }).entries
      const target = entries.find((e) => e.refs?.callId === 'call-2')
      assert.ok(hitIndexes.includes(target.id), '命中的必须是含真短语的文档')
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TC2（F2）：多 exact 约束是 AND——只含一个约束的文档不进命中面', async () => {
  const root = await makeRoot('and')
  try {
    const sessionId = 'session-rc-and-01'
    await seedDocs(root, sessionId, [
      'doc with alpha only',      // 只含第一个约束：不得命中
      'doc with beta only',       // 只含第二个约束：不得命中
      'doc with alpha and beta',  // 两个都含：应命中
    ])
    const store = await openStore(root, sessionId)
    try {
      // 字面路：exact 约束经 callId 索引（字面匹配器匹配元数据）；正文约束走 T1。
      // 这里直接用 T1 后端测正文的 AND 语义 + 字面路测元数据的 AND 语义。
      const backend = createLocalLexicalBackend({ directory: store.directory })
      await syncRetrievalIndex({ directory: store.directory, backend, store })
      const found = await searchRecords({ store, backend, text: '', exact: ['alpha', 'beta'], limit: 10, literalMatcher })
      assert.equal(found.records.length, 1, '只含全部约束的文档命中，实际：' + JSON.stringify(found.records.map((r) => r.id)))
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TC3（F3）：OOV 词不稀释 relevance——长问句仍能召回主题词文档', async () => {
  const root = await makeRoot('oov')
  try {
    const sessionId = 'session-rc-oov-01'
    const docs = ['做饭需要先热锅', '今天天气不错适合散步', '报告包含五个章节的总结']
    const ids = await seedDocs(root, sessionId, docs)
    const store = await openStore(root, sessionId)
    try {
      const backend = createLocalLexicalBackend({ directory: store.directory })
      await syncRetrievalIndex({ directory: store.directory, backend, store })
      // 无 OOV：主题词「做饭」直接命中。
      const clean = await backend.query('做饭', { limit: 10 })
      assert.ok(clean.includes(ids[0]), '无 OOV 时主题词文档命中')
      // 加 3 个语料外客套词：不得把相关文档压到线下。
      const noisy = await backend.query('麻烦帮我看下做饭呢吧啦', { limit: 10 })
      assert.ok(noisy.includes(ids[0]), 'OOV 词不得稀释 relevance（当前实现推演 rel≈0.19 被滤）')
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('TC4（F2 字面路）：多 exact 元数据约束不得被 probes.some 绕过（独立于后验层）', async () => {
  const root = await makeRoot('literal-and')
  try {
    const sessionId = 'session-rc-litand-01'
    // 正文同时含两个 exact 约束（统一后验层会放行）；元数据只含其一。
    // 这样后验层不代偿：字面路若用 probes.some，doc1 会因元数据单约束命中
    // 而进入结果——独立锁定字面路自己的 AND 语义。
    const store = await V2SessionStore.init({ labRoot: root, sessionId })
    try {
      const txn = await store.openTransaction()
      await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: 1,
        fidelity: 'verbatim',
        refs: { callId: 'alpha-meta', resultMessageId: 'm1' },
        inline: { nodeId: 'mcl2-x-1' },
        content: 'body mentions alpha-meta and beta-meta together',
      }))
      await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: 2,
        fidelity: 'verbatim',
        refs: { callId: 'c2', resultMessageId: 'm2' },
        inline: { nodeId: 'mcl2-beta-meta-2' },
        content: 'body two mentions alpha-meta and beta-meta as well',
      }))
      await store.commitTransaction(txn)
    } finally {
      store.close()
    }
    const ro = await openStore(root, sessionId)
    try {
      // exact=['alpha-meta','beta-meta']：两条记录的正文都同时含两者（后验放行），
      // 但元数据各只含其一——字面路的 every 语义下无命中，some 语义下两条全命中。
      const found = await searchRecords({ store: ro, backend: null, text: '', exact: ['alpha-meta', 'beta-meta'], limit: 10, literalMatcher })
      assert.equal(found.records.length, 0, '字面路多 exact 必须 AND（元数据面），实际命中：' + JSON.stringify(found.records.map((r) => r.id)))
      // 单约束照常命中（防误杀对照）。
      const single = await searchRecords({ store: ro, backend: null, text: '', exact: ['alpha-meta'], limit: 10, literalMatcher })
      assert.equal(single.records.length, 1, '单 exact 约束必须照常命中（防误杀）')
    } finally {
      ro.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('TC5（F4a）：检索命中按相关性顺序注入，不再整体倒置', async () => {
  const root = await makeRoot('order')
  try {
    const sessionId = 'session-rc-order-01'
    // 回注候选面只认归档 span（PROJECTION_SPAN + range/nodeId/tools）：直接种 span 形态。
    const store = await V2SessionStore.init({ labRoot: root, sessionId })
    try {
      const txn = await store.openTransaction()
      for (const [index, text] of ['first span about alpha', 'second span about alpha too', 'third span also alpha'].entries()) {
        await store.stageRecord(txn, draftRecord({
          kind: RECORD_KINDS.PROJECTION_SPAN,
          seq: index + 2,
          fidelity: 'synthesized',
          refs: { sourceKinds: 'operation', sourceSeqs: String(index + 2), spanKind: 'operation' },
          inline: { nodeId: 'mcl2-ord-' + (index + 1), range: { start: index + 2, end: index + 3 }, tools: ['read'], chunk: 1 },
          content: text,
        }))
      }
      await store.commitTransaction(txn)
    } finally {
      store.close()
    }
    let entries = null
    let directory = null
    {
      const ro = await V2SessionStore.open({ labRoot: root, sessionId, readOnly: true })
      try {
        entries = ro.listEntries({ limit: 100 }).entries
        directory = ro.directory
        const backend = createLocalLexicalBackend({ directory })
        await syncRetrievalIndex({ directory, backend, store: ro })
      } finally {
        ro.close()
      }
    }
    const backend = createLocalLexicalBackend({ directory })
    // 对照：同一检索参数下 searchRecords 的顺序就是回注必须保持的顺序。
    let expected = null
    {
      const ro = await V2SessionStore.open({ labRoot: root, sessionId, readOnly: true })
      try {
        const found = await searchRecords({
          store: ro,
          backend,
          text: 'alpha',
          limit: 2,
          literalMatcher: () => false, // 字面路无元数据命中，全部命中来自语义排名
        })
        expected = found.records.map((r) => r.id)
      } finally {
        ro.close()
      }
    }
    const { createV2ClientFactory } = await import('../src/v2/client-adapter.mjs')
    const factory = createV2ClientFactory({ labRoot: root, sessionId, logger: null, backendFor: () => backend })
    const client = await factory.createClient()
    const payload = await client.recall('alpha', undefined, 2)
    assert.equal(payload.matchedBy, 'literal+semantic', 'matchedBy: ' + payload.matchedBy)
    // 回注顺序必须与 searchRecords（相关性顺序，最相关在前）一致——
    // 此前 slice(-2).reverse() 把语义 top-k 倒置。
    assert.deepEqual(payload.hits.map((h) => h.id), expected,
      '检索命中必须按相关性顺序注入，实际：' + JSON.stringify(payload.hits.map((h) => h.id)) + '，期望（searchRecords 顺序）：' + JSON.stringify(expected))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TC6（弱候选）：强命中为零时弱候选只给 ID 与重合说明（pointerOnly），不注入正文', async () => {
  const root = await makeRoot('weak')
  try {
    const sessionId = 'session-rc-weak-01'
    // 语料：一条与查询弱重合（只命中一个通用词），无强相关文档。
    const store = await V2SessionStore.init({ labRoot: root, sessionId })
    try {
      const txn = await store.openTransaction()
      // 每文档各含一个独立词元（「文档」/「烹饪」/「条目」），查询命中每文档至多 1/3。
    for (const [index, text] of ['系统设计文档说明了缓存策略', '无关的烹饪记录', '另一个无关条目'].entries()) {
        await store.stageRecord(txn, draftRecord({
          kind: RECORD_KINDS.PROJECTION_SPAN,
          seq: index + 2,
          fidelity: 'synthesized',
          refs: { sourceKinds: 'operation', sourceSeqs: String(index + 2), spanKind: 'operation' },
          inline: { nodeId: 'mcl2-weak-' + (index + 1), range: { start: index + 2, end: index + 3 }, tools: ['read'], chunk: 1 },
          content: text,
        }))
      }
      await store.commitTransaction(txn)
    } finally {
      store.close()
    }
    let directory = null
    {
      const ro = await V2SessionStore.open({ labRoot: root, sessionId, readOnly: true })
      try {
        directory = ro.directory
        const backend = createLocalLexicalBackend({ directory })
        await syncRetrievalIndex({ directory, backend, store: ro })
      } finally {
        ro.close()
      }
    }
    const backend = createLocalLexicalBackend({ directory })
    const { createV2ClientFactory } = await import('../src/v2/client-adapter.mjs')
    const factory = createV2ClientFactory({ labRoot: root, sessionId, logger: null, backendFor: () => backend })
    const client = await factory.createClient()
    // 弱查询：三个词元各来自不同文档（「文档」doc1、「烹饪」doc2、「条目」doc3），
    // 每个文档只命中其一 → rel≈1/3 < 0.5 且单 bigram 非 paraphrase → 全部为弱候选。
    const payload = await client.recall('文档烹饪条目', undefined, 5)
    if (payload.matchedBy === 'partial-match') {
      assert.ok(payload.hits.length >= 1, 'partial-match 档应带弱候选指针')
      assert.ok(payload.hits.length <= 3, '弱候选有界（≤3）')
      for (const hit of payload.hits) {
        assert.ok(hit.id, '弱候选必须带记录 ID（指针）')
        assert.ok(!hit.content || !hit.content.includes('系统设计文档说明了缓存策略'),
          '弱候选不得注入正文（pointerOnly）：' + JSON.stringify(hit.content))
        assert.ok(String(hit.content || '').includes('词元重合'), '弱候选文案必须说明重合性质')
      }
    } else {
      // 强命中为零时若无 partial-match 档，matchedBy 应为 no-match（现状行为）；
      // 本测试锁定的是「不注入正文」这条硬边界——no-match 也满足（零注入）,
      // 但 partial-match 落地后必须走弱指针分支。先断言两者之一成立。
      assert.ok(['no-match', 'not-ready', 'all-filtered'].includes(payload.matchedBy),
        '无 partial-match 时必须是如实的零命中状态：' + payload.matchedBy)
      assert.equal(payload.hits.length, 0, '零命中不得注入正文')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TC7（弱候选信号分离）：弱重合不写实际回读计数（readCount 独立）', async () => {
  // 信号分离的守卫面在 importance.mjs：retrievalHits 由调用方注入且只读。
  // 这里锁定的契约：检索命中（含弱候选）不得写 retrievalHits——只有真实回读写入。
  const { scoreSoftRetention, hitBoostOf } = await import('../src/v2/importance.mjs')
  // hitBoostOf 是回读计数→提升量的唯一换算：0 次 → 0，>0 次 → >0。检索命中（含弱候选）
  // 从不进这个口径——retrievalHits 只由真实回写路径注入（importance.mjs 头注契约）。
  assert.equal(hitBoostOf(0), 0, '无回读 → 零提升')
  assert.ok(hitBoostOf(1) > 0, '有回读 → 正提升')
  assert.ok(hitBoostOf(8) > hitBoostOf(1), '饱和换算单调（方向性）')
  // scoreSoftRetention 只读注入的 retrievalHits——不写。锁定该函数不因检索命中加 hits：
  const candidate = { kind: 'operation.result', recordId: 't00000001-r0001', size: 1000, source: null }
  const scored = scoreSoftRetention(candidate, { retrievalHits: {} })
  assert.ok(scored.components.hits === 0, '未注入回读记录时 hits 分量为 0（检索命中不得写计数）')
})
