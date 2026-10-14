/**
 * v2 fork 迁移测试：闭包规划、执行、映射回源、指纹完整性、needs-migration 阻断。
 *
 * 全部在临时隔离库里跑；不触碰任何真实会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'
import { readRecordById } from '../src/v2/readback.mjs'
import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import {
  planForkClosure,
  executeForkClosure,
  readForkMap,
  readNeedsMigration,
  markNeedsMigration,
  clearNeedsMigration,
  closureFingerprint,
  needsMigrationFileFor,
} from '../src/v2/fork.mjs'

const PARENT = 'aaaa1111bbbb2222cccc3333'
const CHILD = 'dddd4444eeee5555ffff6666'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2fork-${name}-`))
  await ensureLabRoot(root)
  return root
}

/** 在父会话里写入若干已闭合的操作，返回记录 ID 列表。 */
async function seedParent(labRoot, count = 3) {
  const store = await V2SessionStore.init({ labRoot, sessionId: PARENT })
  const txn = await store.openTransaction()
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const callId = `call-${index}`
    const call = await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_CALL,
      seq: index * 2 + 1,
      inline: { range: `${index * 2 + 1}-${index * 2 + 2}` },
      refs: { callId, messageId: `msg-call-${index}`, toolName: 'read', blockIndex: 0 },
      content: `{"file":"a${index}.txt"}`,
    }))
    const result = await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_RESULT,
      seq: index * 2 + 2,
      inline: { range: `${index * 2 + 1}-${index * 2 + 2}` },
      refs: { callId, resultMessageId: `msg-${index}` },
      content: `result body ${index}`,
    }))
    ids.push(call.id, result.id)
  }
  await store.commitTransaction(txn)
  await store.close()
  return ids
}

test('fork：闭包规划只取有记录的会话，缺失父库时如实报告', async () => {
  const root = await makeLabRoot('plan')
  try {
    const empty = await planForkClosure({ labRoot: root, parentSessionId: PARENT })
    assert.equal(empty.exists, false)
    assert.equal(empty.recordCount, 0)

    await seedParent(root, 2)
    const plan = await planForkClosure({ labRoot: root, parentSessionId: PARENT })
    assert.equal(plan.exists, true)
    assert.equal(plan.recordCount, 4)
    assert.ok(plan.payloadBytes > 0, '闭包必须报告载荷字节量')
    assert.match(plan.closureFingerprint, /^sha256:[0-9a-f]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork：执行迁移后子会话能按父 ID 回源读到原文，且父库不被改动', async () => {
  const root = await makeLabRoot('exec')
  try {
    const parentIds = await seedParent(root, 3)
    const before = closureFingerprint(
      (await (async () => {
        const store = await V2SessionStore.open({ labRoot: root, sessionId: PARENT, readOnly: true })
        const entries = store.listEntries({ limit: 100 }).entries
        store.close()
        return entries
      })()),
    )

    const result = await executeForkClosure({
      labRoot: root,
      parentSessionId: PARENT,
      childSessionId: CHILD,
    })
    assert.equal(result.recordCount, parentIds.length)
    assert.equal(result.closureFingerprint, before, '迁移前后闭包指纹必须一致')

    // 子会话：父 ID **原样**可读（fork 保留 ID，不重编号）。
    for (const id of parentIds) {
      const loaded = await readRecordById(root, CHILD, id)
      assert.equal(loaded.ok, true)
      assert.equal(loaded.id, id, 'fork 必须保留父记录 ID，子库不得重新编号')
      assert.match(loaded.payloadText, /a\d\.txt|result body \d/)
    }

    // 子库的 ID 集合与父库逐字相同——这才是「完整历史仍可达」的硬保证。
    const childIds = await (async () => {
      const store = await V2SessionStore.open({ labRoot: root, sessionId: CHILD, readOnly: true })
      const ids = store.listEntries({ limit: 100 }).entries.map((entry) => entry.id)
      store.close()
      return ids
    })()
    assert.deepEqual(childIds, parentIds)

    // 父库指纹未变（迁移是复制，不是搬运）。
    const after = closureFingerprint(
      (await (async () => {
        const store = await V2SessionStore.open({ labRoot: root, sessionId: PARENT, readOnly: true })
        const entries = store.listEntries({ limit: 100 }).entries
        store.close()
        return entries
      })()),
    )
    assert.equal(after, before, '父会话冷库不得被 fork 改写')

    // 映射文件落盘且可读。
    const map = await readForkMap(root, CHILD)
    assert.equal(map.parentSessionId, PARENT)
    assert.equal(Object.keys(map.mapping).length, parentIds.length)
    assert.equal(map.closureFingerprint, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork：父库不存在时拒绝迁移，不产生空壳映射', async () => {
  const root = await makeLabRoot('missing')
  try {
    await assert.rejects(
      () => executeForkClosure({ labRoot: root, parentSessionId: PARENT, childSessionId: CHILD }),
      (error) => error.code === 'EFORKNOPARENT',
    )
    assert.equal(await readForkMap(root, CHILD), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork：needs-migration 标记可写可读可清，且落在子会话目录', async () => {
  const root = await makeLabRoot('needs')
  try {
    await markNeedsMigration(root, CHILD, { parentSessionId: PARENT, reason: '测试' })
    const stuck = await readNeedsMigration(root, CHILD)
    assert.equal(stuck.parentSessionId, PARENT)
    assert.equal(stuck.reason, '测试')
    assert.ok(Array.isArray(stuck.steps) && stuck.steps.length > 0, '阻断时必须给出可执行步骤')

    const file = needsMigrationFileFor(root, CHILD)
    assert.match(file, new RegExp(sessionKeyFor(CHILD)))

    await clearNeedsMigration(root, CHILD)
    assert.equal(await readNeedsMigration(root, CHILD), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork：映射解析是兜底路径——命中才回源，指向坏 ID 或坏文件时如实失败', async () => {
  const root = await makeLabRoot('tamper')
  try {
    await seedParent(root, 1)
    await executeForkClosure({ labRoot: root, parentSessionId: PARENT, childSessionId: CHILD })

    const mapFile = path.join(root, 'v2', 'sessions', sessionKeyFor(CHILD), 'fork-map.json')
    const original = JSON.parse(await readFile(mapFile, 'utf8'))
    const childId = Object.values(original.mapping)[0]

    // 1) 父 namespace 的 ID 命中映射：解析到子 ID 并把原文交回，同时如实标注来源。
    await writeFile(mapFile, JSON.stringify({
      ...original,
      mapping: { 't00000042-r0000': childId },
    }), 'utf8')
    const resolved = await readRecordById(root, CHILD, 't00000042-r0000')
    assert.equal(resolved.ok, true)
    assert.equal(resolved.requestedId, 't00000042-r0000')
    assert.equal(resolved.resolvedVia, 'fork-map')
    assert.equal(resolved.id, childId)

    // 2) 映射指向不存在的子 ID：抛 EREADNOTFOUND，不冒充成功、不返回别的记录。
    await writeFile(mapFile, JSON.stringify({
      ...original,
      mapping: { 't00000042-r0000': 't99999999-r9999' },
    }), 'utf8')
    await assert.rejects(
      () => readRecordById(root, CHILD, 't00000042-r0000'),
      (error) => error.code === 'EREADNOTFOUND',
    )

    // 3) 映射文件本身不是 JSON：不得崩，按「无映射」处理并抛 not-found。
    await writeFile(mapFile, '{ not json', 'utf8')
    await assert.rejects(
      () => readRecordById(root, CHILD, 't00000042-r0000'),
      (error) => error.code === 'EREADNOTFOUND',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork：子会话目录不存在时，plan 报告 exists=false 而不是抛异常', async () => {
  const root = await makeLabRoot('noparentdir')
  try {
    const plan = await planForkClosure({ labRoot: root, parentSessionId: 'ffffffffffffffffffffffff' })
    assert.equal(plan.exists, false)
    assert.equal(plan.recordCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
