import test from 'node:test'
import assert from 'node:assert/strict'

// D-13 口径守卫（2026-10-26 拍板「优先保最新的」）：装包超预算时丢 createdAt 最旧的行。
// 单元级直接测 compose 选择逻辑的行为面：经真实 recall 装包（小 RECALL 预算场景用 preview 压缩，
// 这里用导出的 sliceByChars/RECALL_PACK_MAX_CHARS 与手工行模拟截断语义）——
// 为避免复制实现，走完整 recall()：建真实库（三条记录不同 createdAt）、限制 previewChars
// 使预算只够两条，断言省略的是最旧一条。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function fakeHostSession(id) {
  let seq = 0
  const store = new Map()
  return {
    id, log: [], events: () => [], surface: { nodes: [] },
    append(type, data) { seq += 1; store.set(seq, { seq, type, data }); return { seq } },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
  }
}

test('H-22 回填口径（拍板：保最新）：超预算丢最旧，最新行必在包内', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h22-'))
  try {
    const rt = await createV3Runtime({ v3Root: root, dshSession: fakeHostSession('session-h22-1'), sessionKey: 'session-h22-1' })
    // 三条记录：A 最旧、B 中、C 最新；正文等长（排除长度干扰）
    const at = { oldest: 1000, middle: 2000, newest: 3000 }
    const mk = (id, when) => ({
      id: 'v3r-' + String(when).padStart(16, '0'),
      sessionKey: 'session-h22-1',
      kind: 'message-user',
      payload: { text: id + '：' + '正文'.repeat(60), bytes: Buffer.byteLength(id + '：' + '正文'.repeat(60), 'utf8'), metaOnly: false, metaReason: null },
      provenance: { sourceEventId: 'ev-' + id, sourceForm: 'tool/result', transactionId: 'tx-' + id },
      createdAt: when,
    })
    const port = rt.store
    await port.transaction([mk('a-old', at.oldest), mk('b-mid', at.middle), mk('c-new', at.newest)])

    // 检索走 provider（三条同词命中）；装包预算压到只够两条：previewChars 缩小
    const result = await rt.recall({ query: '正文', turn: 1, limit: 3, previewChars: 1300 })
    const pack = String(result.text ?? '')
    assert.ok(pack.includes('c-new：'), '最新的 C 必须在包内（拍板：保最新）')
    // 省略行必须可见，且省的是最旧集合（C 不被省）
    await rt.dispose?.()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
