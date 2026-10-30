/**
 * B3-10（AUD50-04-05）索引缓存戳碰撞——同大小快速替换 50 次的确定性判据：
 * 旧 mtimeMs:size 戳在快速连写窗口内必有碰撞（Windows 内核计时粒度 ~1-15ms，
 * 实测连 bigint mtimeNs 都躲不开）；修复后戳 = mtimeNs + size + 头 64 字节摘要，
 * 同大小替换必然判异。正常替换、缺失照旧。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { indexStampOf } from '../src/v3/adapters/storage/lexical-index.mjs'

const FILE = 'lexical-index.json'
function storeOf(dir) { return { directory: dir } }

test('B3-10 同大小快速替换 50 次：纳秒戳必须全异（ms 戳在此窗口必有碰撞）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-stamp-'))
  try {
    const file = path.join(root, FILE)
    // 同字节长的 50 个版本快速替换：相邻写几乎必然落在同一毫秒——
    // 旧 mtimeMs:size 戳在该窗口判等（替换不可见），纳秒戳必须逐次判异。
    // 判据是确定性的（每次写都断言戳新），不依赖计时。
    const stamps = new Set()
    for (let i = 0; i < 50; i += 1) {
      await writeFile(file, JSON.stringify({ marker: String(i).padStart(3, '0'), pad: 'x'.repeat(60) }) + '\n', 'utf8')
      const stamp = await indexStampOf(storeOf(root))
      assert.notEqual(stamp, 'absent')
      stamps.add(stamp)
    }
    assert.equal(stamps.size, 50, '同大小替换每次都必须可见（旧 ms 戳做不到）')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-10 正常替换与缺失：行为不回退', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-stamp2-'))
  try {
    assert.equal(await indexStampOf(storeOf(root)), 'absent', '缺失返回 absent')
    const file = path.join(root, FILE)
    await writeFile(file, '{"a":1}\n', 'utf8')
    const s1 = await indexStampOf(storeOf(root))
    await new Promise((r) => setTimeout(r, 5))
    await writeFile(file, '{"a":2}\n', 'utf8')
    assert.notEqual(await indexStampOf(storeOf(root)), s1, '正常替换戳变')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
