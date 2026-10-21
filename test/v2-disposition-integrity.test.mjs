/**
 * 0.13.2 守卫：disposition 账本的**读路径不得删条目**（D-01）。
 *
 * ## 缺陷
 * 旧 `parseLedgerText` 判定「崩溃残留的半行」的唯一依据是「文件末尾有没有 \n」，
 * 不看那一行是不是合法 JSON。于是一条**完整合法的遗忘条目**，只要文件末尾缺 LF
 * （任何不走 `appendFile('…\n')` 的写入路径、外部编辑器、跨平台换行），就被当成
 * 半行；随后 `loadDisposition` 在**读取动作里**把它物理截断删除：
 * - `forgotten` 集合清空 → 该操作此前遗忘的全部记录重新可见（隐私回退）；
 * - `revision` 按 entries.length 算，删除后回退；
 * - `state` 仍报 'ok'、`damaged` 为 false，写侧不拦，下一次发号从 f000001 重来。
 *
 * ## 判据（改回去必红）
 * - 完整条目 + 无尾 LF → revision 不变、文件字节数不变、forgotten 仍生效；
 * - 只有 header + 无尾 LF → 不截断、文件字节数不变；
 * - 只有**解析失败**的尾巴才截断，且被截断的字节数如实上报；
 * - 中部坏行仍是 damaged（写侧 EDISPOSITIONDAMAGED 拒绝），不因本次修复而放宽。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DISPOSITION_ENTRY_FORGET,
  DISPOSITION_HEADER_KIND,
  DISPOSITION_SCHEMA_VERSION,
  applyForget,
  canonicalLine,
  dispositionPath,
  getForgetIndex,
  loadDisposition,
  resetForgetIndexCache,
} from '../src/v2/disposition.mjs'

const header = canonicalLine({ kind: DISPOSITION_HEADER_KIND, schemaVersion: DISPOSITION_SCHEMA_VERSION })

function forgetLine(operationId = 'f000001', targetIds = ['t00000001-r0001']) {
  return canonicalLine({
    kind: DISPOSITION_ENTRY_FORGET,
    operationId,
    entrySeq: 1,
    actor: 'user',
    reason: 'explicit',
    targetIds,
    undoOf: null,
    visibilityRevisionBefore: 0,
    visibilityRevisionAfter: 1,
    at: '2026-01-01T00:00:00.000Z',
  })
}

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-disposition-integrity-'))
  resetForgetIndexCache()
  try {
    return await body(dir)
  } finally {
    resetForgetIndexCache()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('完整条目 + 无尾 LF：读一次账本不得删条目（revision／字节数／forgotten 全不变）', async () => {
  await withTempDir(async (dir) => {
    const file = dispositionPath(dir)
    const text = header + '\n' + forgetLine()
    await writeFile(file, text, 'utf8')
    const before = Buffer.byteLength(text, 'utf8')

    const ledger = await loadDisposition(dir)
    assert.equal(ledger.revision, 1, '完整条目必须被当成条目，不是半行')
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.damaged, false)
    assert.equal(ledger.repairedBytes, 0, '合法条目不是崩溃残留：不得截断任何字节')
    assert.equal(ledger.state, 'ok')

    const after = await readFile(file, 'utf8')
    assert.equal(Buffer.byteLength(after, 'utf8'), before, '读路径不得改写账本（字节数必须不变）')
    assert.equal(after, text)

    const index = await getForgetIndex(dir)
    assert.equal(index.forgotten.size, 1, '遗忘必须仍然生效（0 = 记录重新可见，即隐私回退）')
    assert.ok(index.forgotten.has('t00000001-r0001'))
  })
})

test('只有 header + 无尾 LF：不截断，且不当成「全新会话」以外的损坏', async () => {
  await withTempDir(async (dir) => {
    const file = dispositionPath(dir)
    await writeFile(file, header, 'utf8')
    const ledger = await loadDisposition(dir)
    assert.equal(ledger.damaged, false)
    assert.equal(ledger.repairedBytes, 0, 'header 本身是合法 JSON，不是半行')
    assert.equal(await readFile(file, 'utf8'), header, '文件必须原样保留')
    assert.equal(ledger.state, 'ok', '有 header 就不是 absent')
    assert.equal(ledger.revision, 0)
  })
})

test('只有解析失败的尾巴才截断，且如实上报字节数；前面的条目保留', async () => {
  await withTempDir(async (dir) => {
    const file = dispositionPath(dir)
    const good = header + '\n' + forgetLine()
    const halfLine = '{"kind":"dsh-memory-context-lab/v2/disposition.entry.forget","operationId":"f000002"'
    await writeFile(file, good + '\n' + halfLine, 'utf8')

    const ledger = await loadDisposition(dir)
    assert.equal(ledger.repairedBytes, Buffer.byteLength(halfLine, 'utf8'), '被截掉的字节数必须如实上报')
    assert.equal(ledger.revision, 1, '已完成的条目不得因尾部崩溃而丢失')
    assert.equal(await readFile(file, 'utf8'), good + '\n', '只截掉坏尾巴')
    const index = await getForgetIndex(dir)
    assert.equal(index.forgotten.size, 1)
  })
})

test('中部坏行仍是 damaged：写侧继续失败关闭（不因本次修复而放宽）', async () => {
  await withTempDir(async (dir) => {
    const file = dispositionPath(dir)
    await writeFile(file, header + '\n{ not json }\n' + forgetLine() + '\n', 'utf8')
    const ledger = await loadDisposition(dir)
    assert.equal(ledger.damaged, true)
    assert.equal(ledger.state, 'damaged')
    await assert.rejects(
      () => applyForget({ sessionDir: dir, targetIds: ['t00000001-r0002'], actor: 'user', reason: 'explicit' }),
      (error) => error.code === 'EDISPOSITIONDAMAGED',
    )
  })
})
