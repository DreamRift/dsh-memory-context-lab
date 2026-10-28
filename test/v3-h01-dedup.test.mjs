import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

let seqN = 0
function rec(id, text, ev) {
  seqN += 1
  const body = text
  return {
    id: 'v3r-' + String(id).padStart(16, '0'),
    kind: 'message-user',
    sessionKey: 'session-h01', // 必须与 open 的会话一致（写入侧现在会校验归属）
    createdAt: 1770000000000 + seqN,
    payload: { text: body, bytes: Buffer.byteLength(body, 'utf8') },
    provenance: { sourceEventId: ev, sourceForm: null, transactionId: 'tx-dedup-' + String(seqN).padStart(6, '0') },
  }
}

test('H-01 重复合并：同 sourceEventId 只留最早一条进索引；被取代记录按 ID 仍可回读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h01-'))
  const { port } = await createSessionStorePort(root, 'session-h01')
  // 同一事件的三个时代拷贝（回放重灌的典型产物）：内容略有漂移，createdAt 递增
  await port.transaction([rec('1', '第一版正文：苹果香蕉', 'ev-1')])
  await port.transaction([rec('2', '第二版正文：苹果香蕉橙子', 'ev-1')])
  await port.transaction([rec('3', '第三版正文：苹果香蕉橙子西瓜', 'ev-1')])
  await port.transaction([rec('4', '无关事件正文：番茄', 'ev-2')])
  await port.rebuildIndex()

  const h = await port.health()
  assert.equal(h.indexedCount, 2, '索引文档数 = 不同事件数（ev-1 只留最早 + ev-2）')
  // 检索 ev-1 的关键词：不因三份拷贝霸榜
  const search = await port.health() // health 只作兜底；真检索走 T1——这里直接验证索引内容
  const indexFile = JSON.parse(await readFile(path.join(root, 'sessions', 'session-h01', 'lexical-index.json'), 'utf8'))
  const ids = Object.keys(indexFile.docLengths ?? {})
  assert.ok(ids.includes('v3r-0000000000000001'), '最早拷贝在索引')
  assert.ok(!ids.includes('v3r-0000000000000002') && !ids.includes('v3r-0000000000000003'), '晚到的拷贝不占检索位')
  // 字节保留：被取代的记录仍可精确回读（审计面不受影响）
  const r2 = await port.readRecord('v3r-0000000000000002')
  assert.equal(r2.payload.text, '第二版正文：苹果香蕉橙子')
})
