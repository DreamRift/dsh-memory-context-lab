/**
 * v2 存储层测试：事务与崩溃对账、schema 拒写、只读停用、工具配对、内容寻址。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  V2SessionStore,
  EngineV2Error,
} from '../src/v2/store.mjs'
import {
  RECORDS_SCHEMA_VERSION,
  recordId,
  recordsFromEvent,
  draftRecord,
  RECORD_KINDS,
} from '../src/v2/records.mjs'
import { sessionKeyFor } from '../src/storage.mjs'

const tmpRoots = []

async function newLabRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v2-store-'))
  tmpRoots.push(root)
  return root
}

const ID_TXN1_CALL = recordId(1, 0)
const ID_TXN1_RESULT = recordId(1, 1)

/** 构造一对标准 assistant/message(tool-call) + tool/result 事件与对应记录草案。 */
function callAndResultDrafts(seqBase, callId = `call_${seqBase}`) {
  const callEvent = {
    type: 'assistant/message',
    seq: seqBase,
    data: {
      turn: 1,
      message: {
        id: `msg_${seqBase}`,
        content: [{
          type: 'tool-call',
          id: callId,
          name: 'read_file',
          arguments: { path: `C:/demo/file-${seqBase}.txt` },
        }],
      },
    },
  }
  const resultEvent = {
    type: 'tool/result',
    seq: seqBase + 1,
    data: {
      message: {
        id: `res_${seqBase}`,
        source: { callId },
        content: [{ type: 'text', text: `output of call ${seqBase}` }],
      },
    },
  }
  const drafts = [...recordsFromEvent(callEvent), ...recordsFromEvent(resultEvent)]
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0].kind, RECORD_KINDS.OPERATION_CALL)
  assert.equal(drafts[1].kind, RECORD_KINDS.OPERATION_RESULT)
  return { callEvent, resultEvent, drafts, callId }
}

async function commitCallResult(store, seqBase) {
  const { callId, drafts } = callAndResultDrafts(seqBase)
  const txn = await store.openTransaction()
  for (const draft of drafts) await store.stageRecord(txn, draft)
  const result = await store.commitTransaction(txn)
  assert.equal(result.committedTxn, txn.txn)
  assert.equal(result.recordCount, 2)
  return { callId, ids: [recordId(txn.txn, 0), recordId(txn.txn, 1)] }
}

function sessionDirectory(labRoot, sessionId) {
  return path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(sessionId))
}

function quarantineDirectory(labRoot, sessionId) {
  return path.join(sessionDirectory(labRoot, sessionId), 'quarantine')
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('提交事务后记录、载荷、清单与目录全部落盘', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'a'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    const { ids } = await commitCallResult(store, 1)
    assert.deepEqual(ids, [ID_TXN1_CALL, ID_TXN1_RESULT])
    const header = store.getEntry(ID_TXN1_CALL)
    assert.equal(header.kind, RECORD_KINDS.OPERATION_CALL)
    assert.equal(header.fidelity, 'verbatim')
    const full = await store.readRecord(ID_TXN1_CALL)
    assert.equal(full.ok, true)
    assert.equal(full.integrity, 'ok')
    assert.equal(full.payloadText, JSON.stringify({ path: 'C:/demo/file-1.txt' }))
    const stats = store.stats()
    assert.equal(stats.committedThrough.txn, 1)
    assert.equal(stats.committedThrough.recordCount, 2)
    assert.equal(stats.kinds[RECORD_KINDS.OPERATION_CALL], 1)
    assert.equal(stats.kinds[RECORD_KINDS.OPERATION_RESULT], 1)
    const dir = sessionDirectory(labRoot, sessionId)
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, RECORDS_SCHEMA_VERSION)
    assert.equal(manifest.committedThrough.txn, 1)
    const catalog = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8'))
    assert.equal(catalog.recordCount, 2)
  } finally {
    await store.close()
  }
})

test('重开 Store 后目录从磁盘重建，历史可达', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'b'.repeat(24)
  const first = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(first, 1)
  first.close()
  const store = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const full = await store.readRecord(ID_TXN1_RESULT)
    assert.equal(full.payloadText, 'output of call 1')
    assert.equal(store.stats().committedThrough.recordCount, 2)
  } finally {
    await store.close()
  }
})

test('未提交事务在崩溃后进隔离区，事务号不复用', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'c'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  const txn = await store.openTransaction()
  assert.equal(txn.txn, 1)
  await store.stageRecord(txn, draftRecord({
    kind: RECORD_KINDS.COMMAND_RUN,
    seq: 1,
    refs: { command: 'demo' },
    content: 'wip input',
  }))
  // 模拟提交前崩溃：直接丢弃句柄，不调用 commitTransaction。
  store.close()

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const stats = reopened.stats()
    assert.equal(stats.warnings.length, 1)
    assert.match(stats.warnings[0], /txn-00000001/)
    // 事务号不复用：下一个新事务是 2。
    const txn2 = await reopened.openTransaction()
    assert.equal(txn2.txn, 2)
    assert.equal((await readdir(quarantineDirectory(labRoot, sessionId))).length, 1)
    // 新事务提交成功后历史完整可达，隔离区不影响目录。
    await reopened.stageRecord(txn2, draftRecord({
      kind: RECORD_KINDS.COMMAND_RUN, seq: 2, refs: { command: 'after-crash' }, content: 'after crash',
    }))
    await reopened.commitTransaction(txn2)
    const after = reopened.stats()
    assert.equal(after.committedThrough.txn, 2)
    assert.equal(after.committedThrough.recordCount, 1)
    const read = await reopened.readRecord(recordId(2, 0))
    assert.equal(read.ok, true)
  } finally {
    await reopened.close()
  }
})

test('提交结果不明：事务已标记提交但清单未推进，重启对账采纳并推进', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'd'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  const txn = await store.openTransaction()
  await store.stageRecord(txn, draftRecord({
    kind: RECORD_KINDS.COMMAND_RUN, seq: 1, refs: { command: 'unclear' }, content: 'unclear input',
  }))
  // 模拟「已写 committedAt、未推进 manifest」的崩溃窗口：直接在磁盘上补 committedAt。
  const transactionFile = path.join(sessionDirectory(labRoot, sessionId), 'transactions', 'txn-00000001.json')
  const onDisk = JSON.parse(await readFile(transactionFile, 'utf8'))
  onDisk.committedAt = new Date().toISOString()
  await writeFile(transactionFile, JSON.stringify(onDisk), 'utf8')
  store.close()

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const stats = reopened.stats()
    assert.equal(stats.committedThrough.txn, 1)
    assert.equal(stats.committedThrough.recordCount, 1)
    assert.equal(stats.warnings.length, 0)
    assert.equal((await readdir(quarantineDirectory(labRoot, sessionId)).catch(() => [])).length, 0)
    const read = await reopened.readRecord(recordId(1, 0))
    assert.equal(read.ok, true)
    assert.equal(read.payloadText, 'unclear input')
  } finally {
    await reopened.close()
  }
})

test('清单领先磁盘时对账回退并告警', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'e'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(store, 1)
  store.close()
  const manifestFile = path.join(sessionDirectory(labRoot, sessionId), 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.committedThrough.txn = 5
  manifest.committedThrough.recordCount = 10
  await writeFile(manifestFile, JSON.stringify(manifest), 'utf8')

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const stats = reopened.stats()
    assert.equal(stats.committedThrough.txn, 1)
    assert.equal(stats.committedThrough.recordCount, 2)
    assert.ok(stats.warnings.some((w) => /领先/.test(w)))
  } finally {
    await reopened.close()
  }
})

test('损坏的事务文件进隔离区且不阻塞其余历史', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'f'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(store, 1)
  // 写一个损坏的下一号事务文件。
  const transactionsDir = path.join(sessionDirectory(labRoot, sessionId), 'transactions')
  await writeFile(path.join(transactionsDir, 'txn-00000002.json'), 'not-json{{{', 'utf8')
  store.close()

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const stats = reopened.stats()
    assert.equal(stats.committedThrough.txn, 1)
    assert.ok(stats.warnings.some((w) => /txn-00000002/.test(w)))
    assert.equal((await store.readRecord(ID_TXN1_CALL)).ok, true)
    assert.equal((await readdir(quarantineDirectory(labRoot, sessionId))).length, 1)
  } finally {
    await reopened.close()
  }
})

test('陌生 schema 的事务文件被隔离，不冒充本插件数据', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '0'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(store, 1)
  const transactionsDir = path.join(sessionDirectory(labRoot, sessionId), 'transactions')
  await writeFile(path.join(transactionsDir, 'txn-00000002.json'), JSON.stringify({
    kind: 'other-plugin/transaction',
    schemaVersion: RECORDS_SCHEMA_VERSION,
    txn: 2,
    committedAt: new Date().toISOString(),
    records: [],
  }), 'utf8')
  store.close()

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const stats = reopened.stats()
    assert.equal(stats.committedThrough.txn, 1)
    assert.ok(stats.warnings.some((w) => /schema，已隔离/.test(w)))
    // 事务号不复用陌生文件占用的号。
    const txn = await reopened.openTransaction()
    assert.equal(txn.txn, 3)
  } finally {
    await reopened.close()
  }
})

test('schema 拒写：未知 kind / 未知保真 / 缺 refs / 哈希伪造 / verbatim 无载荷', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '1'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    const txn = await store.openTransaction()
    await assert.rejects(
      () => store.stageRecord(txn, { kind: 'evil_kind', seq: 1, refs: {} }),
      (error) => error instanceof EngineV2Error && error.code === 'ESCHEMA')
    await assert.rejects(
      () => store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 1, fidelity: 'bogus',
        refs: { messageId: 'm', turn: 1 }, content: 'x',
      })),
      (error) => error.code === 'ESCHEMA')
    await assert.rejects(
      () => store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 1,
        refs: { messageId: 'm' }, content: 'x',
      })),
      (error) => error.code === 'ESCHEMA')
    const forged = draftRecord({
      kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 1,
      refs: { messageId: 'm', turn: 1 }, content: 'hello',
    })
    forged.payload.hash = `sha256:${'0'.repeat(64)}`
    await assert.rejects(
      () => store.stageRecord(txn, forged),
      (error) => error.code === 'EHASH')
    await assert.rejects(
      () => store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 1, refs: { messageId: 'm', turn: 1 },
      })),
      (error) => error.code === 'ESCHEMA')
    const payloadDir = path.join(sessionDirectory(labRoot, sessionId), 'payloads')
    assert.equal((await readdir(payloadDir).catch(() => [])).length, 0)
  } finally {
    await store.close()
  }
})

test('disable 后同句柄拒绝写入，重开只读可读不可写，旧 ID 可读', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '2'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(store, 1)
  await store.disable('任务完成，收尾停用')
  await assert.rejects(() => store.openTransaction(),
    (error) => error instanceof EngineV2Error && error.code === 'EREADONLY')
  store.close()

  const readonly = await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
  try {
    const full = await readonly.readRecord(ID_TXN1_RESULT)
    assert.equal(full.payloadText, 'output of call 1')
    assert.equal(readonly.stats().recordCount, 2)
    assert.equal(readonly.disabled, true)
    await assert.rejects(() => readonly.disable('再停用一次'),
      (error) => error instanceof EngineV2Error && error.code === 'EREADONLY')
  } finally {
    await readonly.close()
  }

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    await assert.rejects(() => reopened.openTransaction(),
      (error) => error instanceof EngineV2Error && error.code === 'EREADONLY')
    assert.equal((await reopened.readRecord(ID_TXN1_CALL)).ok, true)
  } finally {
    await reopened.close()
  }
})

test('reenable 后恢复写入能力', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '3'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  await commitCallResult(store, 1)
  await store.disable('临时停用')
  store.close()
  const revived = await V2SessionStore.open({ labRoot, sessionId })
  try {
    await revived.reenable()
    const { ids } = await commitCallResult(revived, 3)
    const stats = revived.stats()
    assert.equal(stats.committedThrough.txn, 2)
    const read = await revived.readRecord(ids[0])
    assert.equal(read.ok, true)
  } finally {
    await revived.close()
  }
})

test('工具配对：闭合、重复调用、孤儿结果，重启后账本一致', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '4'.repeat(24)
  let store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    await commitCallResult(store, 1) // 正常闭合
    // 重复调用：第二个同名 callId。
    let txn = await store.openTransaction()
    const duplicate = recordsFromEvent({
      type: 'assistant/message', seq: 9,
      data: { turn: 2, message: { id: 'msg_dup', content: [
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: {} },
      ] } },
    })
    await store.stageRecord(txn, duplicate[0])
    await store.commitTransaction(txn)
    // 孤儿结果：result 先于 call。
    txn = await store.openTransaction()
    const orphanResult = recordsFromEvent({
      type: 'tool/result', seq: 11,
      data: { message: { id: 'res_orphan', source: { callId: 'orphan_call' }, content: [
        { type: 'text', text: 'late result' },
      ] } },
    })
    const orphanCall = recordsFromEvent({
      type: 'assistant/message', seq: 12,
      data: { turn: 3, message: { id: 'msg_orphan', content: [
        { type: 'tool-call', id: 'orphan_call', name: 'bash', arguments: {} },
      ] } },
    })
    await store.stageRecord(txn, orphanResult[0])
    await store.stageRecord(txn, orphanCall[0])
    await store.commitTransaction(txn)

    const ledger = store.pairingLedger()
    assert.deepEqual(store.openCalls(), [])
    assert.equal(ledger.get('call_1').results ?? true, true)
    assert.equal(ledger.get('call_1').resultRecordId, ID_TXN1_RESULT)
    assert.equal(ledger.get('call_1').duplicateCallRecordIds.length, 1)
    const orphan = ledger.get('orphan_call')
    assert.equal(orphan.orphan, true)
    assert.equal(orphan.callRecordId, null)
    assert.equal(orphan.resultRecordId, recordId(3, 0))
  } finally {
    await store.close()
  }
  store = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const ledger = store.pairingLedger()
    assert.deepEqual(store.openCalls(), [])
    assert.equal(ledger.size, 2)
    assert.equal(ledger.get('call_1').duplicateCallRecordIds.length, 1)
    assert.equal(ledger.get('orphan_call').orphan, true)
  } finally {
    await store.close()
  }
})

test('openCalls 报告在途动作，闭合后清空', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '7'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    const txn = await store.openTransaction()
    const call = recordsFromEvent({
      type: 'assistant/message', seq: 1,
      data: { turn: 1, message: { id: 'm1', content: [
        { type: 'tool-call', id: 'pending_call', name: 'bash', arguments: {} },
      ] } },
    })
    await store.stageRecord(txn, call[0])
    await store.commitTransaction(txn)
    assert.equal(store.openCalls().length, 1)
    assert.equal(store.openCalls()[0].callId, 'pending_call')
    // 提交对应结果后闭合。
    const txn2 = await store.openTransaction()
    const result = recordsFromEvent({
      type: 'tool/result', seq: 2,
      data: { message: { id: 'r1', source: { callId: 'pending_call' }, content: [
        { type: 'text', text: 'done' },
      ] } },
    })
    await store.stageRecord(txn2, result[0])
    await store.commitTransaction(txn2)
    assert.deepEqual(store.openCalls(), [])
  } finally {
    await store.close()
  }
})

test('同内容记录共享同一内容寻址载荷', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '5'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    const txn = await store.openTransaction()
    await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 1, refs: { messageId: 'm', turn: 1 }, content: 'same',
    }))
    await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.ASSISTANT_TEXT, seq: 2, refs: { messageId: 'm', turn: 1 }, content: 'same',
    }))
    await store.commitTransaction(txn)
    const payloadShards = await readdir(path.join(sessionDirectory(labRoot, sessionId), 'payloads'))
    // 单载荷目录：所有同内容记录指向同一文件。
    assert.equal(payloadShards.length, 1)
    const files = await readdir(path.join(sessionDirectory(labRoot, sessionId), 'payloads', payloadShards[0]))
    assert.equal(files.length, 1)
  } finally {
    await store.close()
  }
})

test('载荷被篡改后哈希校验失败且内容不返回', async () => {
  const labRoot = await newLabRoot()
  const sessionId = '6'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  const { ids } = await commitCallResult(store, 1)
  const full = await store.readRecord(ids[0])
  assert.equal(full.integrity, 'ok')
  const hex = full.record.payload.hash.slice('sha256:'.length)
  const payloadFile = path.join(sessionDirectory(labRoot, sessionId), 'payloads', hex.slice(0, 2), hex)
  const buffer = await readFile(payloadFile)
  buffer[0] ^= 0xff // 等长翻转，绕过 size 检查，命中哈希校验。
  await writeFile(payloadFile, buffer)
  store.close()

  const reopened = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const tampered = await reopened.readRecord(ids[0])
    assert.equal(tampered.ok, true)
    assert.equal(tampered.integrity, 'hash-mismatch')
    assert.equal(tampered.payloadText, null)
    // 未受影响的记录照常回读。
    const intact = await reopened.readRecord(ids[1])
    assert.equal(intact.integrity, 'ok')
    assert.equal(intact.payloadText, 'output of call 1')
  } finally {
    await reopened.close()
  }
})

test('稳定 ID 定宽全序与解析', async () => {
  assert.equal(recordId(3, 2), 't00000003-r0002')
  assert.equal(recordId(12, 40), 't00000012-r0040')
  const sorted = [recordId(2, 0), recordId(10, 0), recordId(2, 1)].sort()
  assert.deepEqual(sorted, [recordId(2, 0), recordId(2, 1), recordId(10, 0)])
  // 0.13.2 D-17：越界抛带 code 的 EngineV2Error，不抛裸 RangeError——调用方按
  // `error.code` 分支，裸 RangeError 的 code 是 undefined，所有分支都会落空。
  assert.throws(() => recordId(0, 1), (error) => error instanceof EngineV2Error && error.code === 'ELIMIT')
  assert.throws(() => recordId(1, 10_000), (error) => error instanceof EngineV2Error && error.code === 'ELIMIT')
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ok ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
for (const root of tmpRoots) {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
if (failed > 0) process.exit(1)
console.log(`v2-store: ${tests.length - failed}/${tests.length} passed`)
