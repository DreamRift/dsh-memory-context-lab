/**
 * v2 验证矩阵补充：目录重建后历史仍可达、历史原文不冒充授权/新观察、
 * 重启后未闭合配对仍受保护、schema 拒写不污染既有历史。
 *
 * 全部在临时隔离库里跑合成夹具，不触碰真实会话与正式灵枢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, unlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'
import { readRecordById, listRecordsPage } from '../src/v2/readback.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { classifyRange, auditPairingRecords, GUARD_CODES } from '../src/v2/guard.mjs'

const SESSION_ID = 'matrix000000000000000001'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2mx-${name}-`))
  await ensureLabRoot(root)
  return root
}

function sessionDirectory(labRoot) {
  return path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(SESSION_ID))
}

/** 造一次「已闭合、已曝光」的完整操作：调用 + 结果。 */
async function seedOperation(store, { index, callId, text }) {
  const txn = await store.openTransaction()
  const seq = index * 2 + 1
  await store.stageRecord(txn, draftRecord({
    kind: RECORD_KINDS.OPERATION_CALL,
    seq,
    inline: { range: `${seq}-${seq + 1}` },
    refs: { callId, messageId: `msg-call-${index}`, toolName: 'read', blockIndex: 0 },
    content: `{"file":"f${index}.txt"}`,
  }))
  const result = await store.stageRecord(txn, draftRecord({
    kind: RECORD_KINDS.OPERATION_RESULT,
    seq: seq + 1,
    fidelity: 'verbatim',
    inline: { range: `${seq}-${seq + 1}` },
    refs: { callId, resultMessageId: `msg-res-${index}` },
    content: text,
  }))
  await store.commitTransaction(txn)
  return { callRecordId: result.id, callId, seq }
}

test('目录缓存被删后重建：完整历史仍可达（含载荷回读）', async () => {
  const root = await makeLabRoot('catalog')
  try {
    let store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const seeded = await seedOperation(store, { index, callId: `call-${index}`, text: `原文-${index}` })
      ids.push(seeded.callRecordId)
    }
    assert.equal(store.recordCount, 6)
    store.close()

    // 目录缓存是可随时重建的加速层：删掉它，历史不得因此丢失。
    const directory = sessionDirectory(root)
    const files = await readdir(directory)
    assert.ok(files.includes('catalog.json'), '提交后应存在目录缓存')
    await unlink(path.join(directory, 'catalog.json'))

    store = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    assert.equal(store.recordCount, 6, '重开时必须从提交事务重建完整目录')
    store.close()

    for (let index = 0; index < ids.length; index += 1) {
      const loaded = await readRecordById(root, SESSION_ID, ids[index])
      assert.equal(loaded.ok, true)
      assert.equal(loaded.payloadText, `原文-${index}`)
    }

    const page = await listRecordsPage(root, SESSION_ID, { pageSize: 10 })
    assert.equal(page.total, 6)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目录缓存被篡改成陌生 schema 时，重建而不是采信缓存', async () => {
  const root = await makeLabRoot('catalog-foreign')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    await seedOperation(store, { index: 0, callId: 'call-x', text: '原文-x' })
    store.close()

    const directory = sessionDirectory(root)
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify({
      kind: 'someone-else/catalog',
      schemaVersion: 99,
      entries: { 'fake-id': { kind: 'operation_call' } },
    }), 'utf8')

    const reopened = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    assert.equal(reopened.recordCount, 2, '缓存不可信时按提交事务重建')
    assert.equal(reopened.getEntry('fake-id'), null, '陌生缓存不得冒充本插件记录')
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('回读渲染把历史标成「当时原文」，不冒充新授权或新观察', async () => {
  const root = await makeLabRoot('provenance')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const seeded = await seedOperation(store, {
      index: 0,
      callId: 'call-perm',
      text: '{"granted":true,"scope":"deploy"}',
    })
    store.close()

    const runtime = createV2Runtime({
      labRoot: root,
      services: null,
      logger: null,
      hostVersion: 'test',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
      defaultSettings: () => ({ auto: true, recall: true }),
    })

    const result = await runtime.read({ agent: { session: { id: SESSION_ID } } }, [seeded.callRecordId])
    assert.equal(result.kind, 'success')
    assert.match(result.text, /冷库历史原文/)
    assert.match(result.text, /不是新授权、也不是对文件当前状态的观察/)
    // 原文本身照实给出（不篡改内容），但被明确框定为历史记录。
    assert.match(result.text, /"granted":true/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('重启后未闭合的工具配对仍受保护，不能被退热', async () => {
  const root = await makeLabRoot('pairing')
  try {
    let store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    // 只有调用、没有结果：这是一次在途动作。
    const txn = await store.openTransaction()
    await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_CALL,
      seq: 1,
      inline: { range: '1-2' },
      refs: { callId: 'call-open', messageId: 'msg-open', toolName: 'write', blockIndex: 0 },
      content: '{"path":"a.txt"}',
    }))
    await store.commitTransaction(txn)
    assert.equal(store.openCalls().length, 1)
    store.close()

    // 模拟重启：重新打开后账本必须仍然认得这次未闭合配对。
    store = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    const open = store.openCalls()
    assert.equal(open.length, 1, '重启后未闭合配对不得丢失')
    assert.equal(open[0].callId, 'call-open')
    store.close()

    // 冷库侧的配对结论与「会话里未闭合」必须一致：按落库索引复核，而不是相信
    // 内存里一次成功返回。
    const reopened = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    const records = reopened.listEntries({ limit: 100 }).entries.map((entry) => ({
      kind: entry.kind,
      refs: entry.refs,
      inline: entry.inline,
    }))
    const audit = auditPairingRecords(records)
    assert.equal(audit.closed, false, '冷库索引必须认出未闭合配对')
    assert.deepEqual(audit.unclosed, ['call-open'])
    reopened.close()

    // 门禁侧：范围里工具调用没有同范围结果 → 拦下（在途动作必须留在热上下文）。
    const events = {
      1: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-open' }] } } },
      2: { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } },
    }
    const verdict = classifyRange({
      eventAt: (seq) => events[seq] ?? null,
      rangeStart: 1,
      rangeEnd: 2,
      surfaceSeqs: [1, 2],
      lastAssistantSeq: 5,
    })
    assert.equal(verdict.safe, false, '未闭合配对必须拦下')
    assert.equal(verdict.code, GUARD_CODES.UNCLOSED_PAIR)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('辅助模型事件未进主模型活动面时不得降温', async () => {
  // 事件写在日志里、但不在主模型活动面上（例如标题/摘要/裁决这类辅助请求）。
  const events = {
    1: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-aux' }] } } },
    2: { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-aux' } } } },
  }
  const verdict = classifyRange({
    eventAt: (seq) => events[seq] ?? null,
    rangeStart: 1,
    rangeEnd: 2,
    // 只有 seq 1 在主模型活动面上；seq 2 是辅助模型产生的事件。
    surfaceSeqs: [1],
    lastAssistantSeq: 5,
  })
  assert.equal(verdict.safe, false, '未曝光结果不得被当作已曝光证据降温')
  assert.equal(verdict.code, GUARD_CODES.NOT_IN_SURFACE)
})

test('schema 拒写：坏记录不得进入既有历史，已有记录不受影响', async () => {
  const root = await makeLabRoot('schema')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const seeded = await seedOperation(store, { index: 0, callId: 'call-ok', text: '好记录' })
    const before = store.recordCount

    const txn = await store.openTransaction()
    await assert.rejects(
      () => store.stageRecord(txn, {
        kind: 'not-a-real-kind',
        seq: 99,
        fidelity: 'verbatim',
        refs: {},
        inline: {},
      }),
      (error) => error.code === 'ESCHEMA',
    )
    await store.abandonTransaction(txn)
    assert.equal(store.recordCount, before, '拒写不得改变已有历史')

    // 借同一句柄读回（同会话目录在本进程内只允许一个句柄）。
    const loaded = await readRecordById(root, SESSION_ID, seeded.callRecordId, { store })
    assert.equal(loaded.payloadText, '好记录')
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('陌生 schema 的事务文件被隔离，不冒充本插件历史', async () => {
  const root = await makeLabRoot('foreign-txn')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    await seedOperation(store, { index: 0, callId: 'call-a', text: '原文-a' })
    store.close()

    const directory = sessionDirectory(root)
    const txns = path.join(directory, 'transactions')
    await mkdir(txns, { recursive: true })
    await writeFile(path.join(txns, 'txn-99999999.json'), JSON.stringify({
      kind: 'other-plugin/transaction',
      schemaVersion: 1,
      txn: 99999999,
      records: [{ kind: 'operation_call' }],
    }), 'utf8')

    const reopened = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    assert.equal(reopened.recordCount, 2, '陌生事务不得被采纳为历史')
    assert.ok(
      reopened.warnings.some((warning) => /隔离|foreign|陌生/i.test(warning)),
      `应有隔离告警，实际：${JSON.stringify(reopened.warnings)}`,
    )
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
