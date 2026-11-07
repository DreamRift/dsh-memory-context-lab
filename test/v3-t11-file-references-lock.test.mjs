/**
 * T-11 守卫（0.15.4）：文件引用账本的写入必须串行且不丢并发条目。
 *
 * 旧缺陷：`writeFileReferences` 直接整本覆盖、无锁。两个句柄各自持内存快照
 * → 后写覆盖先写 → 先写的引用凭空消失（核证面随即把「读过」误判成「没读过」）。
 * 反向红线：遗忘路径是**权威删除**，不能用合并把引用加回来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  fileReferencesPath,
  readFileReferences,
  writeFileReferences,
} from '../src/v3/adapters/storage/file-references.mjs'

const refOf = (id, filePath) => ({
  id, recordId: 'v3r-' + id.padEnd(16, '0').slice(0, 16), path: filePath,
  status: 'verifiable', workspaceRoot: 'C:/ws', sha256: 'x'.repeat(64),
})

test('T-11：并发写入不互相覆盖（锁内重读后按路径合并）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 't11-'))
  try {
    // 两个「句柄」各持自己的快照，同时写。旧实现会丢一边。
    const handleA = [refOf('a', 'src/a.mjs')]
    const handleB = [refOf('b', 'src/b.mjs')]
    await Promise.all([
      writeFileReferences(dir, handleA),
      writeFileReferences(dir, handleB),
    ])

    const { refs } = await readFileReferences(dir)
    assert.deepEqual(refs.map((ref) => ref.path).sort(), ['src/a.mjs', 'src/b.mjs'], '两边的引用都必须保留')

    // 同路径覆盖：后写的赢，且不产生重复条目。
    await writeFileReferences(dir, [{ ...refOf('a2', 'src/a.mjs'), status: 'unverifiable' }])
    const again = await readFileReferences(dir)
    const aRows = again.refs.filter((ref) => ref.path === 'src/a.mjs')
    assert.equal(aRows.length, 1, '同路径只能有一条：' + JSON.stringify(again.refs.map((r) => r.path)))
    assert.equal(aRows[0].status, 'unverifiable', '同路径以本次写入为准')

    // 落盘不得含绝对路径（M6）。
    const text = await readFile(fileReferencesPath(dir), 'utf8')
    assert.equal(text.includes('C:/ws'), false, 'workspaceRoot 不得落盘')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('T-11 反向：遗忘用 merge:false 整本替换，被摘掉的引用不得复活', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 't11b-'))
  try {
    await writeFileReferences(dir, [refOf('a', 'src/a.mjs'), refOf('b', 'src/b.mjs')])
    assert.equal((await readFileReferences(dir)).refs.length, 2)

    // 遗忘 a：整本替换成只剩 b。若走合并，a 会按磁盘旧值被加回来（隐私回退）。
    await writeFileReferences(dir, [refOf('b', 'src/b.mjs')], { merge: false })
    const { refs } = await readFileReferences(dir)
    assert.deepEqual(refs.map((ref) => ref.path), ['src/b.mjs'], '被摘掉的引用不得复活：' + JSON.stringify(refs.map((r) => r.path)))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('T-11 反向：账本损坏时不得被当成空表覆盖', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 't11c-'))
  try {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(fileReferencesPath(dir), '{ not json', 'utf8')
    await assert.rejects(
      () => writeFileReferences(dir, [refOf('a', 'src/a.mjs')]),
      /损坏/,
      '账本坏了必须拒绝写入（坏 ≠ 空，覆盖会把「坏」变成「丢」）',
    )
    assert.equal(await readFile(fileReferencesPath(dir), 'utf8'), '{ not json', '坏账本必须原样保留')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
