/**
 * T2 覆盖率口径与显式回填的纯逻辑测试（0.14.0-beta.38）。
 *
 * 钉住用户口径里的三条数字纪律：
 * - 分母只算 payload.text 非空的可镜像记录：metadata-only / 空正文 / 已遗忘一律不计；
 * - 冒烟节点（mcl-smoke）与写入闸拒绝节点（rej_*）不计入已镜像；
 * - 「未知」不得用 0 冒充：清单缺失/损坏 / 状态文件损坏都必须抛错，由命令面显示未知。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  parseBackfillLimit,
  planBackfill,
  runBackfill,
  T2_BACKFILL_DEFAULT_LIMIT,
  T2_BACKFILL_MAX_LIMIT,
} from '../src/v3/application/t2-backfill.mjs'
import { scanMirrorableRecords, scanMirroredNodes } from '../src/v3/adapters/storage/mirror-inventory.mjs'
import { readBackfillState, T2_BACKFILL_FILE, writeBackfillState } from '../src/v3/adapters/storage/t2-backfill-state.mjs'
import { T2_MIRROR_NODE_RE, T2_SMOKE_NODE_ID } from '../src/v3/contracts/t2.mjs'

const ID_A = 'v3r-aaaaaaaaaaaaaaaa'
const ID_B = 'v3r-bbbbbbbbbbbbbbbb'

function record(id, text, extra = {}) {
  return { id, sessionKey: 's', kind: 'message-user', createdAt: 1, payload: { text, ...extra }, provenance: {} }
}

/** 最小 store 替身：只提供清单与遗忘集，记录正文按真实文件读。 */
function fakeStore(directory, ids, forgotten = []) {
  return {
    directory,
    async listRecordIds() { return [...ids] },
    listForgotten() { return [...forgotten] },
  }
}

async function tempDir(prefix) {
  return await mkdtemp(path.join(tmpdir(), prefix))
}

async function writeRecord(directory, record_) {
  const records = path.join(directory, 'records')
  await mkdir(records, { recursive: true })
  await writeFile(path.join(records, record_.id + '.json'), JSON.stringify(record_) + '\n')
}

test('parseBackfillLimit：默认 200、上限 2000；非法参数回用法错误而不是夹值', () => {
  assert.deepEqual(parseBackfillLimit(undefined), { ok: true, limit: T2_BACKFILL_DEFAULT_LIMIT })
  assert.deepEqual(parseBackfillLimit(''), { ok: true, limit: T2_BACKFILL_DEFAULT_LIMIT })
  assert.deepEqual(parseBackfillLimit('20'), { ok: true, limit: 20 })
  assert.deepEqual(parseBackfillLimit(String(T2_BACKFILL_MAX_LIMIT)), { ok: true, limit: T2_BACKFILL_MAX_LIMIT })
  for (const bad of ['0', String(T2_BACKFILL_MAX_LIMIT + 1), 'abc', '-1', '1.5', '2e3']) {
    const parsed = parseBackfillLimit(bad)
    assert.equal(parsed.ok, false, bad + ' 必须被拒绝')
    assert.match(parsed.message, /1–2000/, bad + ' 的用法错误必须写出真实取值域')
  }
})

test('scanMirrorableRecords：分母只算非空正文；metaOnly/空正文/已遗忘分开计数', async () => {
  const directory = await tempDir('mcl-coverage-records-')
  try {
    await writeRecord(directory, record(ID_A, '正文 A'))
    await writeRecord(directory, record(ID_B, '正文 B'))
    await writeRecord(directory, record('v3r-cccccccccccccccc', '', { metaOnly: true, metaReason: 'assistant 无可见文本块' }))
    await writeRecord(directory, record('v3r-dddddddddddddddd', ''))
    await writeRecord(directory, record('v3r-eeeeeeeeeeeeeeee', '已遗忘正文'))
    const ids = [ID_A, ID_B, 'v3r-cccccccccccccccc', 'v3r-dddddddddddddddd', 'v3r-eeeeeeeeeeeeeeee']
    const scan = await scanMirrorableRecords(fakeStore(directory, ids, ['v3r-eeeeeeeeeeeeeeee']))
    assert.deepEqual({ ...scan, records: undefined }, {
      total: 5, forgotten: 1, mirrorable: 2, metaOnly: 1, emptyText: 1, records: undefined,
    })
    assert.deepEqual(scan.records.map((row) => row.id), [ID_A, ID_B], '可镜像清单按 ID 稳定排序')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})

test('scanMirrorableRecords：清单与磁盘不一致必须抛错（未知 ≠ 0）', async () => {
  const directory = await tempDir('mcl-coverage-missing-')
  try {
    await assert.rejects(
      () => scanMirrorableRecords(fakeStore(directory, [ID_A])),
      (error) => error?.code === 'ESTORE_CORRUPT',
    )
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})

test('scanMirroredNodes：只数 v3r-*；冒烟与拒绝节点单独计数且不计入覆盖率', async () => {
  const root = await tempDir('mcl-coverage-nodes-')
  try {
    const orphan = path.join(root, 'knowledge', 'orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, ID_A + '.md'), 'x')
    await writeFile(path.join(orphan, ID_B + '.md'), 'x')
    await writeFile(path.join(orphan, T2_SMOKE_NODE_ID + '.md'), 'x')
    await writeFile(path.join(orphan, 'rej_1234567890.md'), 'x')
    await writeFile(path.join(orphan, 'something-else.md'), 'x')
    const scan = await scanMirroredNodes(root)
    assert.equal(scan.state, 'ok')
    assert.equal(scan.mirrored, 2)
    assert.equal(scan.smoke, 1)
    assert.equal(scan.rejected, 1)
    assert.equal(scan.other, 1)
    assert.deepEqual([...scan.nodes].sort(), [ID_A, ID_B])
    assert.ok(T2_MIRROR_NODE_RE.test(ID_A))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('scanMirroredNodes：隔离根不存在回 absent（与 ok+0 分开）', async () => {
  const root = path.join(await tempDir('mcl-coverage-absent-'), 'nope')
  const scan = await scanMirroredNodes(root)
  assert.equal(scan.state, 'absent')
  assert.equal(scan.mirrored, 0)
  assert.equal(scan.nodes.size, 0)
})

test('planBackfill：已镜像的记录不重复入队（幂等），limit 只截断不重排', () => {
  const records = [record(ID_B, 'B'), record(ID_A, 'A'), record('v3r-cccccccccccccccc', '')]
  const plan = planBackfill({ records, mirroredIds: new Set([ID_B]), limit: 1 })
  assert.deepEqual(plan.pending.map((row) => row.id), [ID_A], '已镜像与空正文都跳过')
  assert.equal(plan.pendingTotal, 1)
  assert.equal(plan.alreadyMirrored, 1)
  // 重复执行（同一镜像集）不会产生第二批。
  const again = planBackfill({ records, mirroredIds: new Set([ID_A, ID_B]), limit: 10 })
  assert.equal(again.pending.length, 0)
})

test('runBackfill：批间可中断；失败只计数不中断', async () => {
  const signal = { aborted: false }
  const calls = []
  let failed = 0
  const provider = {
    mirrorRecord(record_) {
      calls.push(record_.id)
      if (record_.id === 'v3r-bbbbbbbbbbbbbbbb') failed += 1
      if (calls.length === 2) signal.aborted = true
    },
    async flush() {},
    mirrorStats() { return { mirrored: calls.length, mirrorFailed: failed, mirrorDropped: 0 } },
  }
  const records = [ID_A, ID_B, 'v3r-cccccccccccccccc', 'v3r-dddddddddddddddd'].map((id) => record(id, 'x'))
  const result = await runBackfill({ provider, records, signal, chunkSize: 1 })
  assert.equal(result.status, 'cancelled', '第二批之后必须停止')
  assert.equal(result.processed, 2)
  assert.equal(result.failed, 1, '失败只计数，不打断已处理的批次')
})

test('回填状态：原子写回读；坏文件抛 ESTORE_CORRUPT（不拿 0 冒充）', async () => {
  const directory = await tempDir('mcl-coverage-state-')
  try {
    assert.equal(await readBackfillState(directory), null)
    const written = await writeBackfillState(directory, { status: 'running', planned: 3 })
    assert.equal(written.schemaVersion, 1)
    const read = await readBackfillState(directory)
    assert.equal(read.status, 'running')
    assert.equal(read.planned, 3)
    assert.ok(Number.isInteger(read.updatedAt))
    await writeFile(path.join(directory, T2_BACKFILL_FILE), '{bad json')
    await assert.rejects(() => readBackfillState(directory), (error) => error?.code === 'ESTORE_CORRUPT')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})
