/**
 * P8 §9.1/§9.4：旧 state / 旧 voucher **不变**（迁移只读，不重写历史）。
 *
 * ## 判据
 * - 0.14.0-beta.54 形状的 state.json 读得懂、错误面为 null、读路径**不写盘**
 *   （字节不变）；未知/缺失的新字段回落默认值，不改写用户显式状态；
 * - 0.14.0-beta.54 形状的凭证（无 restoreChars、summaryText 为空）在 history 里
 *   如实显示 restoreChars=null / summary=false，仍可逐字节 restore；
 * - 新归档只**追加**一行凭证：旧行字节逐字节不变，旧凭证下标与恢复能力不变。
 *
 * ## 不适用条件与已知边界
 * 本用例只证明读兼容与「不重写」；显式写入（mode/pin 等）仍按当前 schema 归一化，
 * 这是既有写路径口径，不是迁移引擎——本切片不新增任何迁移器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionState, sessionStatePath } from '../src/v3/adapters/storage/session-state.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'

const SESSION_KEY = 'sess-p8-compat'
const OLD_STATE = {
  schemaVersion: 1,
  mode: 'full-history',
  modeSource: 'explicit',
  planFirst: false,
  autoRestore: true,
  pins: ['v3r-00000000000000a1'],
  readLease: [{ recordId: 'v3r-00000000000000a2', expiresAt: 1792845000000 }],
  surface: { lastArchiveEndSeq: 8, lastArchiveAt: 1792845000000 },
  cooling: { open: false, lastOccupancy: null, lastRunAt: null, lastReason: null },
  provider: { tier: 'T1', reason: '本地词法索引（T1）' },
  updatedAt: 1792845000000,
}

function record(id, text) {
  return {
    id,
    kind: 'operation',
    sessionKey: SESSION_KEY,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + id, sourceForm: 'tool/result', transactionId: 'tx-' + id },
  }
}

test('P8 旧 state：读得懂、不重写、缺新字段回落默认', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-compat-state-'))
  try {
    // 每个变体用独立会话路径：state 读缓存按「路径 + 同 tick 目录闸门」命中，
    // 同一路径同 tick 内改写文件不在本用例的判据面上（B3-9 既有行为）。
    const file = sessionStatePath(root, SESSION_KEY + '-state')
    await mkdir(path.dirname(file), { recursive: true })
    const bytes = JSON.stringify(OLD_STATE) + '\n'
    await writeFile(file, bytes, 'utf8')

    const state = readSessionState(root, SESSION_KEY + '-state', { defaultMode: 'full-history' })
    assert.equal(state.error, undefined, '旧形状不得报损坏')
    assert.equal(state.mode, 'full-history')
    assert.equal(state.modeSource, 'explicit')
    assert.deepEqual(state.pins, ['v3r-00000000000000a1'], 'pin 原样保留（保护资格不变）')
    assert.deepEqual(state.readLease, [{ recordId: 'v3r-00000000000000a2', expiresAt: 1792845000000 }])
    assert.equal(state.surface.lastArchiveEndSeq, 8)
    assert.equal(state.surface.lastArchiveAt, 1792845000000)
    assert.equal(await readFile(file, 'utf8'), bytes, '读路径不得重写旧 state（迁移只读）')

    // beta.43 以前的 state：没有 lastArchiveAt / planFloorSeq / cooling 的新字段
    const older = { schemaVersion: 1, mode: 'recall-only', pins: [], surface: { lastArchiveEndSeq: 3 } }
    const olderBytes = JSON.stringify(older) + '\n'
    const olderFile = sessionStatePath(root, SESSION_KEY + '-older')
    await mkdir(path.dirname(olderFile), { recursive: true })
    await writeFile(olderFile, olderBytes, 'utf8')
    const readOlder = readSessionState(root, SESSION_KEY + '-older')
    assert.equal(readOlder.error, undefined)
    assert.equal(readOlder.mode, 'recall-only', '旧会话的 recall-only 不被静默改成新默认')
    assert.equal(readOlder.surface.lastArchiveAt, null)
    assert.equal(readOlder.planFloorSeq, null)
    assert.equal(await readFile(olderFile, 'utf8'), olderBytes, '读路径不得补写缺失字段')

    // 换代（schemaVersion 落后）如实可见，但仍是「可用 + 可判读」，不抛错、不改写
    const stale = { ...OLD_STATE, schemaVersion: 0 }
    const staleBytes = JSON.stringify(stale) + '\n'
    const staleFile = sessionStatePath(root, SESSION_KEY + '-stale')
    await mkdir(path.dirname(staleFile), { recursive: true })
    await writeFile(staleFile, staleBytes, 'utf8')
    const readStale = readSessionState(root, SESSION_KEY + '-stale')
    assert.equal(readStale.error, 'ESTATE_VERSION', '版本落后必须可见（不静默当同版）')
    assert.equal(readStale.mode, 'full-history')
    assert.equal(await readFile(staleFile, 'utf8'), staleBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P8 旧 voucher：history/restore 兼容，新归档只追加（旧行字节不变）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-compat-voucher-'))
  const ID1 = 'v3r-0000000000000b01'
  const ID2 = 'v3r-0000000000000b02'
  const RECEIPT = '[记忆上下文] 已归档 2 个完成步骤；凭证 v-5。'
  try {
    const first = await createSessionStorePort(root, SESSION_KEY)
    await first.port.transaction([record(ID1, '第一条记录正文'), record(ID2, '第二条记录正文')])
    const dir = first.store.directory
    first.store.close()

    // 0.14.0-beta.54 形状：有 summaryText（空），**没有** restoreChars（beta.50 之后才加）
    const oldLine = JSON.stringify({
      schemaVersion: 2,
      voucherId: 'v-5',
      kind: 'span',
      recordIds: [ID1, ID2],
      sourceEventSeqs: [3, 4],
      startSeq: 3,
      endSeq: 4,
      targetEventId: 5,
      receiptText: RECEIPT,
      summaryText: '',
      txn: 1,
    }) + '\n'
    await writeFile(path.join(dir, 'vouchers.jsonl'), oldLine, 'utf8')

    const second = await createSessionStorePort(root, SESSION_KEY)
    try {
      const ops = []
      const nodes = new Map([[5, RECEIPT]])
      const host = {
        surfaceNodes: () => [...nodes.keys()],
        surfaceTextAt: (seq) => nodes.get(seq),
        surfaceOp: async (op) => { ops.push(op); return { seq: 9 } },
      }
      const archive = createArchiveService({
        store: second.port,
        host,
        clock: { now: () => 1792845000000 },
        random: { uuid: () => '00000000-0000-0000-0000-000000000001' },
      })

      const history = archive.history()
      assert.equal(history.total, 1)
      assert.equal(history.rows[0].restoreChars, null, '旧凭证没有 restoreChars → null（不猜 0）')
      assert.equal(history.rows[0].summary, false)
      assert.equal(history.rows[0].recordIds.length, 2)
      assert.equal(history.rows[0].targetEventId, 5)

      const restored = await archive.restoreVoucher(0)
      assert.equal(restored.restored, true, JSON.stringify(restored))
      assert.equal(restored.chars, '第一条记录正文\n\n第二条记录正文'.length)
      assert.equal(ops.length, 1)
      assert.match(ops[0].text, /第一条记录正文/)
      assert.match(ops[0].text, /第二条记录正文/)

      // 新凭证追加（模拟后续归档）：旧行字节必须原样保留
      await second.port.appendVoucher({
        schemaVersion: 2,
        voucherId: 'v-9',
        kind: 'span',
        recordIds: [ID1],
        sourceEventSeqs: [7],
        startSeq: 7,
        endSeq: 7,
        targetEventId: 9,
        receiptText: '[记忆上下文] 已归档 1 个完成步骤；凭证 v-9。',
        summaryText: '',
        restoreChars: 7,
        txn: 2,
      })
      const onDisk = (await readFile(path.join(dir, 'vouchers.jsonl'), 'utf8')).split('\n')
      assert.equal(onDisk[0] + '\n', oldLine, '旧凭证行逐字节不变（不重写历史）')
      assert.equal(onDisk.length, 3, '只追加一行（末尾空行除外）')
      assert.equal(archive.history().total, 2, '旧下标 0 不变，新凭证按顺序追加')
    } finally {
      second.store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
