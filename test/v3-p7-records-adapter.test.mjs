/**
 * P7 记录端口（真实 SessionStore）：复用既有 tool/result 记录，不新建记录类型/第二套冷库。
 *
 * ## 这条套件证明什么
 * - 每个 tool/result 事件本来就有一条 kind='operation' 记录（process-turn），
 *   provenance.sourceEventId='dsh-<seq>'；端口只查找/回读，**不写记录**；
 * - 事务幂等：重复调用返回同一记录 ID，记录数不增；
 * - forget / undo / export / adopt 全部沿用既有链：遗忘后 EFORGOTTEN、撤销后可读、
 *   导出包含正文且遗忘后剔除、导入生成新 ID 且 sourceEventId=null（不串会话）。
 *
 * ## 不证明什么（待授权）
 * 真实 runtime 里摄入是后台异步的：决定替换的那个 pre-step 里记录可能尚未落库。
 * 端口的 ensureIngested 只证明「补齐后可用」，真实接线点与下一请求观测仍未验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createFirstIngressRecordPort } from '../src/v3/adapters/storage/first-ingress-records.mjs'
import { createProcessTurn } from '../src/v3/application/process-turn.mjs'
import { normalizeDshEvent } from '../src/v3/adapters/host/dsh-host.mjs'
import { buildExportBundle, exportFilenameOf } from '../src/v3/domain/export/bundle.mjs'
import { readExportBundle, writeExportBundle } from '../src/v3/adapters/storage/export-writer.mjs'
import { contentHashOf } from '../src/v3/domain/first-ingress/preview.mjs'
import { TOOL_RESULT_ERROR_MARKER } from '../src/v3/contracts/records.mjs'

const KEY = 's-p7-records'
const BIG = 'X'.repeat(9000)

function counters() {
  let n = 0
  return () => {
    n += 1
    // 记录 ID 取 uuid 的前 16 位，序号必须落在前 16 位，否则所有 ID 都是 0000000000000000。
    return n.toString(16).padStart(16, '0') + '0'.repeat(16)
  }
}

async function openStore(root, key = KEY) {
  // createSessionStorePort 返回 { port, store }：测试只用端口面（与生产调用方同形）。
  const opened = await createSessionStorePort(root, key)
  return opened.port
}

// 整个套件共用一个递增计数器：每次摄入拿到不同记录 ID（重复摄入测试需要两份不同 ID 的拷贝）。
const sharedUuid = counters()

function makeTurn(store) {
  return createProcessTurn({
    store,
    clock: { now: () => 1000 },
    random: { uuid: sharedUuid },
    ownSourceKinds: ['user'],
  })
}

/** 用真实归一化 + processTurn 摄入一条 tool/result（模拟既有摄入链，不改记录形状）。 */
async function ingestToolResult({ port, seq, text = BIG, isError = false }) {
  const raw = {
    seq,
    type: 'tool/result',
    time: 1700000000000,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'r-' + seq, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'c' + seq }, toolCallId: 'c' + seq, isError },
    },
  }
  const normalized = normalizeDshEvent(raw, KEY)
  assert.equal(normalized.ok, true, JSON.stringify(normalized))
  const turn = makeTurn(port)
  // 真实摄入链的 tool/result 正文由 extractEventBody 生成：可读错误结果会追加错误态标记。
  // 这里显式镜像该形状，否则测试记录会缺标记、测不到 isError 核对。
  const body = isError ? text + '\n' + TOOL_RESULT_ERROR_MARKER : text
  const out = await turn({ event: normalized.event, text: body })
  assert.equal(out.status, 'applied', JSON.stringify(out))
}

async function withStore(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p7-records-'))
  let port = null
  try {
    port = await openStore(root)
    return await body({ root, port })
  } finally {
    try { port?.close?.() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P7-R1 复用既有 operation 记录：按 dsh-<seq> 定位，不新建记录、不改形状', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const before = await port.listRecordIds()
    assert.equal(before.length, 1)

    const adapter = createFirstIngressRecordPort({ store: port })
    assert.equal(await port.recordIdOfSourceEvent('dsh-3'), before[0])
    const persisted = await adapter.persistOriginal({ seq: 3 })
    assert.equal(persisted.recordId, before[0])
    assert.equal(persisted.text, BIG)
    const read = await adapter.readOriginal(persisted.recordId)
    assert.equal(read.text, BIG)
    assert.deepEqual(await port.listRecordIds(), before, '只读不写：记录数不变')
    const record = await port.readRecord(before[0])
    assert.equal(record.kind, 'operation')
    assert.equal(record.provenance.sourceEventId, 'dsh-3')
  })
})

test('P7-R2 幂等：重复 persistOriginal 返回同一 ID，不产生第二份记录', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port })
    const a = await adapter.persistOriginal({ seq: 3 })
    const b = await adapter.persistOriginal({ seq: 3 })
    assert.equal(a.recordId, b.recordId)
    assert.equal((await port.listRecordIds()).length, 1)
  })
})

test('P7-R3 未摄入即失败关闭；提供 ensureIngested 时用既有摄入链补齐', async () => {
  await withStore(async ({ port }) => {
    const adapter = createFirstIngressRecordPort({ store: port })
    await assert.rejects(() => adapter.persistOriginal({ seq: 9 }), /ERECORD_NOT_FOUND|还没有可读记录/)

    // 最小必要扩展：接线方注入「补齐该事件」的同步入口；这里用同一条 processTurn 链。
    let calls = 0
    const withEnsure = createFirstIngressRecordPort({
      store: port,
      ensureIngested: async ({ sourceEventId, seq }) => {
        calls += 1
        if (await port.recordIdOfSourceEvent(sourceEventId) === null) await ingestToolResult({ port, seq })
      },
    })
    const out = await withEnsure.persistOriginal({ seq: 9 })
    assert.equal(calls, 1)
    assert.equal(typeof out.recordId, 'string')
    assert.equal(out.text, BIG)
    // 幂等：第二次 ensureIngested 发现记录已在，不再写
    await withEnsure.persistOriginal({ seq: 9 })
    assert.equal((await port.listRecordIds()).length, 1)
  })
})

test('P7-R4 forget/undo 级联：遗忘后 EFORGOTTEN，撤销后可读（原文不删）', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port })
    const { recordId } = await adapter.persistOriginal({ seq: 3 })

    await port.forget([recordId])
    await assert.rejects(() => adapter.readOriginal(recordId), /EFORGOTTEN|遗忘/)
    await assert.rejects(() => adapter.persistOriginal({ seq: 3 }), /EFORGOTTEN|遗忘/)

    await port.revokeForget([recordId])
    assert.equal((await adapter.readOriginal(recordId)).text, BIG)
    assert.equal((await adapter.persistOriginal({ seq: 3 })).recordId, recordId)
  })
})

test('P7-R5 export：分享包含正文；遗忘后导出剔除该记录（沿用既有导出合同）', async () => {
  await withStore(async ({ root, port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port })
    const { recordId } = await adapter.persistOriginal({ seq: 3 })
    const record = await port.readRecord(recordId)

    const bundle = buildExportBundle({ sessionKey: KEY, exportedAt: 1000, records: [record], forgotten: [], vouchers: [] })
    assert.equal(bundle.records.length, 1)
    assert.equal(bundle.records[0].payload.text.length, BIG.length)
    const fileName = exportFilenameOf(KEY, bundle.exportedAt)
    await writeExportBundle(root, KEY, bundle)
    const roundtrip = await readExportBundle(root, fileName)
    assert.equal(roundtrip.records[0].payload.text, BIG)

    await port.forget([recordId])
    const after = buildExportBundle({ sessionKey: KEY, records: [record], forgotten: [recordId], vouchers: [] })
    assert.equal(after.records.length, 0, '已遗忘正文不得出现在分享包')
    assert.deepEqual(after.forgotten, [recordId])
  })
})

test('P7-R6 adopt/import：新会话得到新 ID 且 sourceEventId=null，不串原会话句柄', async () => {
  await withStore(async ({ root, port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port })
    const { recordId } = await adapter.persistOriginal({ seq: 3 })
    const record = await port.readRecord(recordId)

    const other = await openStore(root, 's-p7-adopted')
    try {
      const imported = await other.importRecords([{ kind: record.kind, payload: { text: record.payload.text } }])
      const newId = imported.recordIds[0]
      assert.notEqual(newId, recordId)
      assert.equal((await other.readRecord(newId)).payload.text, BIG)
      assert.equal((await other.readRecord(newId)).provenance.sourceEventId, null, '导入记录不得继承来源事件 ID')
      assert.equal(await other.recordIdOfSourceEvent('dsh-3'), null)
      // 原会话句柄仍然有效
      assert.equal((await adapter.readOriginal(recordId)).text, BIG)
    } finally {
      other.close()
    }
  })
})

test('P7-R7 contentHash 入参真正被使用：如实回报记录正文是否与宿主原文一致（不据此拒绝脱敏副本）', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port })
    const first = await adapter.persistOriginal({ seq: 3 })
    const exact = contentHashOf([{ type: 'text', text: first.text }])
    const matched = await adapter.persistOriginal({ seq: 3, contentHash: exact })
    assert.equal(matched.surfaceHashMatched, true, '未脱敏：记录正文与宿主原文 hash 一致')
    const stale = await adapter.persistOriginal({ seq: 3, contentHash: '0'.repeat(16) })
    assert.equal(stale.surfaceHashMatched, false, '不等是合法事实（脱敏/已改写），只回报不拒绝')
    assert.equal(stale.text, first.text)
    assert.equal(stale.recordId, first.recordId)
    await assert.rejects(() => adapter.persistOriginal({ seq: 3, contentHash: 'not-a-hash' }), /contentHash/)
  })
})

test('P7-R8 isError 入参真正被使用：与记录错误态标记不一致时显式拒绝', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    await ingestToolResult({ port, seq: 5, isError: true })
    const adapter = createFirstIngressRecordPort({ store: port })
    const ok = await adapter.persistOriginal({ seq: 3, isError: false })
    assert.equal(ok.recordErrorMarked, false)
    const failed = await adapter.persistOriginal({ seq: 5, isError: true })
    assert.equal(failed.recordErrorMarked, true)
    assert.ok(failed.text.endsWith('[工具结果：错误态]'), '错误态标记是记录里的唯一权威标记')
    await assert.rejects(() => adapter.persistOriginal({ seq: 5, isError: false }), /错误态标记|口径不一致/)
    await assert.rejects(() => adapter.persistOriginal({ seq: 3, isError: true }), /错误态标记|口径不一致/)
    await assert.rejects(() => adapter.persistOriginal({ seq: 3, isError: 'yes' }), /isError/)
  })
})

test('P7-R9 callId 入参真正被使用：转交补齐入口；未注入时不假装核验过', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const plain = await createFirstIngressRecordPort({ store: port }).persistOriginal({ seq: 3, callId: 'c3' })
    assert.equal(plain.callIdAttested, false, '记录合同不存 callId，未注入补齐入口时不得声称核验过')
    const seen = []
    const withEnsure = createFirstIngressRecordPort({
      store: port,
      ensureIngested: async (args) => { seen.push(args) },
    })
    const attested = await withEnsure.persistOriginal({ seq: 3, callId: 'c3' })
    assert.equal(attested.callIdAttested, true)
    assert.deepEqual(seen, [{ sourceEventId: 'dsh-3', seq: 3, callId: 'c3' }])
    await assert.rejects(() => withEnsure.persistOriginal({ seq: 3, callId: 42 }), /callId/)
  })
})

test('P7-R10 重复摄入时固定取字典序最小 ID（句柄跨次稳定）', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3, text: 'A'.repeat(9000) })
    await ingestToolResult({ port, seq: 3, text: 'B'.repeat(9000) })
    const ids = (await port.listRecordIds()).slice().sort()
    assert.equal(ids.length, 2, '重复摄入产生两份拷贝（字节保留）')
    assert.equal(await port.recordIdOfSourceEvent('dsh-3'), ids[0], '必须取最小 ID')
    const adapter = createFirstIngressRecordPort({ store: port })
    const a = await adapter.persistOriginal({ seq: 3 })
    const b = await adapter.persistOriginal({ seq: 3 })
    assert.equal(a.recordId, ids[0])
    assert.equal(b.recordId, ids[0], '同一句柄跨次调用不漂移')
  })
})

test('P7-R11 两种 hash 分别命名（G4）：原文 hash 与记录正文 hash 不同义，脱敏时不相等也不互换', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3, text: BIG })
    const adapter = createFirstIngressRecordPort({ store: port, sessionKey: KEY })
    // 模拟「宿主原文被脱敏后落库」：调用方手里的原文 hash 与记录正文 hash 不同。
    const originalHash = contentHashOf([{ type: 'text', text: BIG + ' 秘钥=sk-test-123456' }])
    const out = await adapter.persistOriginal({ seq: 3, contentHash: originalHash })
    assert.equal(out.surfaceHashMatched, false, '脱敏改变字节：两个 hash 不相等是合法事实，不据此拒绝')
    assert.equal(out.surfaceContentHashMatched, out.surfaceHashMatched, '两个名字指向同一个事实（协议名 + 兼容名）')
    assert.equal(out.recordTextHash, contentHashOf([{ type: 'text', text: out.text }]), 'recordTextHash 只描述已落库副本')
    assert.notEqual(out.recordTextHash, originalHash, '两种 hash 不得互相顶替')
    assert.equal(out.surfaceEventId, 'dsh-3', '稳定来源身份来自 provenance')
    const read = await adapter.readOriginal(out.recordId)
    assert.equal(read.recordTextHash, out.recordTextHash, '回读报告的正文 hash 与落库时同口径')
  })
})

test('P7-R12 会话绑定（G4）：跨会话/错误归属的记录一律失败关闭，不复用别人的正文', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const owned = createFirstIngressRecordPort({ store: port })
    const { recordId } = await owned.persistOriginal({ seq: 3 })
    // 同一份记录被另一个会话的端口拿到：必须拒绝（不是「读不到」，是「不属于你」）
    const foreign = createFirstIngressRecordPort({ store: port, sessionKey: 's-p7-other' })
    await assert.rejects(() => foreign.readOriginal(recordId), /ESTORE_SESSION_MISMATCH|不属于本会话/)
    await assert.rejects(() => foreign.persistOriginal({ seq: 3 }), /ESTORE_SESSION_MISMATCH|不属于本会话/)
    // 绑定会话的端口照常可用（防误杀对照）
    assert.equal((await createFirstIngressRecordPort({ store: port, sessionKey: KEY }).readOriginal(recordId)).text, BIG)
  })
})

test('P7-R13 遗忘代际（G4）：forget 改变可读性、undo 回到同一 digest，读不到不说成「没变」', async () => {
  await withStore(async ({ port }) => {
    await ingestToolResult({ port, seq: 3 })
    const adapter = createFirstIngressRecordPort({ store: port, sessionKey: KEY })
    const { recordId } = await adapter.persistOriginal({ seq: 3 })
    const before = await adapter.generationOf(recordId)
    assert.equal(before.readable, true)
    assert.equal(before.forgotten, false)
    await port.forget([recordId])
    const forgotten = await adapter.generationOf(recordId)
    assert.equal(forgotten.readable, false)
    assert.equal(forgotten.forgotten, true, '遗忘必须是可判读的状态，不是空白')
    assert.notEqual(forgotten.digest, before.digest, '代际必须变化（调用方据此放弃外置）')
    await port.revokeForget([recordId])
    const undone = await adapter.generationOf(recordId)
    assert.equal(undone.readable, true, 'undo 后可读')
    assert.equal(undone.digest, before.digest, '同一正文的 undo 回到同一 digest（不把 undo 误判成内容变化）')
  })
})

test('P7-R14 来源事件复核（G4）：记录不是由这条来源事件摄入时失败关闭', async () => {
  const recId = 'v3r-' + 'ab'.repeat(8)
  const stub = {
    async recordIdOfSourceEvent() { return recId },
    async readRecord() {
      return { id: recId, sessionKey: 's-p7', kind: 'operation', payload: { text: 'T' }, provenance: { sourceEventId: 'dsh-999' } }
    },
  }
  const adapter = createFirstIngressRecordPort({ store: stub })
  await assert.rejects(() => adapter.persistOriginal({ seq: 3 }), /来源事件/)
  // sessionKey 未注入时不判会话归属；注入后同一份记录因来源事件不符仍然拒绝
  const bound = createFirstIngressRecordPort({ store: stub, sessionKey: 's-p7' })
  await assert.rejects(() => bound.persistOriginal({ seq: 3 }), /来源事件/)
})
