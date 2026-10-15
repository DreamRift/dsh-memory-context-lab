/**
 * 验证跟踪（PR #4 0.9.0 落地）：
 *
 * - extractFilePaths 纯函数：白名单字段、绝对路径过滤、坏 JSON 跳过。
 * - capture → check 往返：未变 valid / 改动 stale / 删除 stale / 无指纹 unverified。
 * - markStale：只写旁证（记录本体不动）、优先级高于指纹核对、原因必填。
 * - 失败关闭：旁证损坏 → unverified，绝不伪造 valid。
 * - syncVerification 差集：已采集过的记录绝不重采（防止把「事后改动」洗成 valid）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  extractFilePaths,
  captureFingerprints,
  checkRecords,
  markRecordsStale,
  syncVerification,
  annotateStale,
} from '../src/v2/verification.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'

async function withTempLab(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mdcl-verify-'))
  const sessionDir = path.join(root, 'session')
  try {
    await fn(sessionDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 一个最小 store stub：只实现采集与差集用到的 listEntries / readRecord。 */
function stubStore(records) {
  return {
    listEntries() {
      return { entries: Object.keys(records).map((id) => ({ id })) }
    },
    async readRecord(id, { verifyHash = true, maxBytes = null } = {}) {
      const record = records[id]
      if (!record) return { ok: false, error: 'not found' }
      return {
        ok: true,
        id,
        record,
        entry: { kind: record.kind },
        payloadText: record.paramsText ?? null,
        integrity: 'ok',
        truncated: false,
        fullBytes: 0,
      }
    },
  }
}

test('extractFilePaths：白名单字段 + 绝对路径过滤，宁少勿错', () => {
  const win = 'C:\\Users\\cty05\\Documents\\AI\\demo.md'
  assert.deepEqual(
    extractFilePaths(JSON.stringify({ file_path: win })),
    [win],
    'file_path 绝对路径必须提取',
  )
  assert.deepEqual(
    extractFilePaths(JSON.stringify({ path: '/home/u/notes.txt', workdir: '/home/u' })),
    ['/home/u/notes.txt', '/home/u'],
    'path 与 workdir 都在白名单',
  )
  assert.deepEqual(extractFilePaths(JSON.stringify({ file_path: 'docs/README.md' })), [], '相对路径不提取')
  assert.deepEqual(extractFilePaths(JSON.stringify({ command: `Get-Content ${win}` })), [], '命令文本里的路径不提取')
  assert.deepEqual(extractFilePaths('not json'), [], '坏 JSON 跳过')
  assert.deepEqual(extractFilePaths(JSON.stringify({ nested: { file_path: win } })), [], '嵌套对象不递归')
  assert.deepEqual(extractFilePaths(''), [], '空串跳过')
  assert.deepEqual(extractFilePaths(null), [], '非字符串跳过')
})

test('capture → check 往返：未变 valid，改动/删除 stale，无指纹 unverified', async () => {
  await withTempLab(async (sessionDir) => {
    const target = path.join(sessionDir, '..', 'target.md')
    await writeFile(target, 'v1 原文', 'utf8')
    const store = stubStore({
      't00000001-r0001': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }) },
      't00000002-r0002': { kind: 'projection.span', paramsText: null },
    })
    await captureFingerprints({ store, sessionDir, recordIds: ['t00000001-r0001', 't00000002-r0002'] })

    const first = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(first.results[0].verdict, 'valid', '未改动时必须 valid')
    assert.equal(first.results[0].matchedFiles, 1)

    const noFp = await checkRecords({ sessionDir, recordIds: ['t00000002-r0002'] })
    assert.equal(noFp.results[0].verdict, 'unverified', '非 operation.call 无指纹 → unverified')

    await writeFile(target, 'v2 改后', 'utf8')
    const second = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(second.results[0].verdict, 'stale', '内容改动后必须 stale')
    assert.equal(second.results[0].code, 'EVERIFICATIONSTALE')

    await rm(target, { force: true })
    const third = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(third.results[0].verdict, 'stale', '文件删除（曾有指纹）判 stale，不是 unverified')
  })
})

test('markStale：只写旁证、不改记录本体；人工标记优先；原因必填', async () => {
  await withTempLab(async (sessionDir) => {
    const target = path.join(sessionDir, '..', 'keep.md')
    await writeFile(target, '内容从未变', 'utf8')
    const store = stubStore({
      't00000001-r0001': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }) },
    })
    await captureFingerprints({ store, sessionDir, recordIds: ['t00000001-r0001'] })

    const outcome = await markRecordsStale({ sessionDir, recordIds: ['t00000001-r0001'], reason: '用户判断该证据已失效' })
    assert.equal(outcome.ok, true)

    // 记录本体（store 的参数 JSON）没有被改写：旁证是唯一被写的文件。
    const again = store.readRecord('t00000001-r0001')
    assert.equal((await again).payloadText, JSON.stringify({ file_path: target }), '记录本体不可变')

    // 内容没变但被人工标记 → stale（人工标记优先于指纹核对）。
    const verdict = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(verdict.results[0].verdict, 'stale')
    assert.match(verdict.results[0].reason, /人工标记/)

    // 回读注记：零 hash，只查人工标记。
    const marks = await annotateStale({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(marks.get('t00000001-r0001'), '用户判断该证据已失效')

    // 对无指纹的旧记录也允许标记（先建旁证条目）。
    await markRecordsStale({ sessionDir, recordIds: ['t00000009-r0009'], reason: '升级前的旧记录' })
    const old = await checkRecords({ sessionDir, recordIds: ['t00000009-r0009'] })
    assert.equal(old.results[0].verdict, 'stale', '无指纹记录被人工标记后是 stale')

    // 原因必填（审计要求）。
    await assert.rejects(
      () => markRecordsStale({ sessionDir, recordIds: ['t00000001-r0001'], reason: '   ' }),
      (error) => error.code === 'EBADINPUT',
    )
  })
})

test('失败关闭：旁证损坏 → 全部 unverified，绝不伪造 valid', async () => {
  await withTempLab(async (sessionDir) => {
    const target = path.join(sessionDir, '..', 'x.md')
    await writeFile(target, '原文', 'utf8')
    const store = stubStore({
      't00000001-r0001': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }) },
    })
    await captureFingerprints({ store, sessionDir, recordIds: ['t00000001-r0001'] })

    // 损坏旁证文件（截断 JSON）。
    const sidecar = path.join(sessionDir, 'verification.json')
    await writeFile(sidecar, '{"kind": "dsh-memory-context-lab/v2/verific', 'utf8')

    const verdict = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(verdict.results[0].verdict, 'unverified', '旁证损坏必须失败关闭为 unverified')
    assert.match(verdict.results[0].reason, /失败关闭/)

    // markStale 在旁证损坏时以空表重建（可继续写人工标记）。
    await markRecordsStale({ sessionDir, recordIds: ['t00000001-r0001'], reason: '旁证损坏后的人工标记' })
    const after = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001'] })
    assert.equal(after.results[0].verdict, 'stale')
  })
})

test('syncVerification 差集：已采集的记录绝不重采，防止事后改动洗成 valid', async () => {
  await withTempLab(async (sessionDir) => {
    const target = path.join(sessionDir, '..', 'y.md')
    await writeFile(target, '首版', 'utf8')
    const records = {
      't00000001-r0001': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }) },
    }
    const store = stubStore(records)

    const first = await syncVerification({ store, sessionDir })
    assert.equal(first.captured, 1, '首次差集补采 1 条')

    // 首采后改动文件（模拟归档后的正常写入）。
    await writeFile(target, '事后改动', 'utf8')

    // 新记录落库 → 只补采新差集；旧记录不重采（指纹仍是「v1 首版」）。
    records['t00000002-r0002'] = { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }) }
    const second = await syncVerification({ store, sessionDir })
    assert.equal(second.captured, 1, '只补采新增的差集记录')

    const verdicts = await checkRecords({ sessionDir, recordIds: ['t00000001-r0001', 't00000002-r0002'] })
    assert.equal(verdicts.results[0].verdict, 'stale', '旧记录保持首采指纹：事后改动如实判 stale')
    assert.equal(verdicts.results[1].verdict, 'valid', '新记录以「事后改动」内容首采，判 valid（口径如文档所写）')

    // 旁证原子写：文件必须以换行结尾且 kind/schemaVersion 固定。
    const raw = JSON.parse(await readFile(path.join(sessionDir, 'verification.json'), 'utf8'))
    assert.equal(raw.kind, 'dsh-memory-context-lab/v2/verification')
    assert.equal(raw.schemaVersion, 1)
  })
})
