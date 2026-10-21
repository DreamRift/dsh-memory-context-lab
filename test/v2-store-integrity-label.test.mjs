/**
 * 0.13.2-beta.2 守卫：读路径的完整性标注必须两维都如实。
 *
 * ## 缺陷
 * `#readPayload` 在全文读通、尺寸一致时恒返回 `integrity: 'ok'`——**包括
 * `verifyHash: false`（根本没算哈希）的情况**。BUG-012 已经把 `verified` 拆成
 * 独立一维，但 `integrity` 仍报 `'ok'`，调用方很容易把 `'ok'` 读成「校验通过」，
 * 而这条路径恰恰连哈希都没算过。PR #8 审计把它列为「报告但未改」的最后一项。
 *
 * 现在：`verifyHash: true` → `'ok'`；`verifyHash: false` → `'unverified'`；
 * 无载荷 → `'no-payload'`（语义不变）。
 *
 * ## 判据（改回去必红）
 * 把 `#readPayload` 的返回改回恒 `'ok'`，第二条断言即红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'

async function withLab(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-integrity-label-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function seed(store) {
  const handle = await store.openTransaction()
  const withPayload = await store.stageRecord(handle, draftRecord({
    kind: RECORD_KINDS.PROJECTION_SPAN,
    seq: 1,
    fidelity: 'synthesized',
    refs: { sourceKinds: ['assistant.text'], sourceSeqs: [1], spanKind: 'operation' },
    inline: { label: '带载荷', range: { start: 1, end: 1 } },
    content: '带载荷的正文',
  }))
  const withoutPayload = await store.stageRecord(handle, draftRecord({
    kind: RECORD_KINDS.OPERATION_CALL,
    seq: 2,
    fidelity: 'synthesized',
    refs: { callId: 'call-1', toolName: 'read', messageId: 'm1', blockIndex: 0 },
    inline: { label: '无载荷' },
  }))
  await store.commitTransaction(handle)
  return { withPayload: withPayload.id, withoutPayload: withoutPayload.id }
}

test('校验过报 ok、没校验报 unverified、无载荷报 no-payload', async () => {
  await withLab(async (labRoot) => {
    const sessionId = 'integrity-label'.padEnd(24, '0')
    const store = await V2SessionStore.init({ labRoot, sessionId })
    try {
      const ids = await seed(store)

      const checked = await store.readRecord(ids.withPayload, { verifyHash: true })
      assert.equal(checked.ok, true)
      assert.equal(checked.integrity, 'ok', '真做过哈希校验且通过才配叫 ok')
      assert.equal(checked.verified, true)

      const unchecked = await store.readRecord(ids.withPayload, { verifyHash: false })
      assert.equal(unchecked.ok, true)
      assert.equal(
        unchecked.integrity,
        'unverified',
        '没算哈希却报 ok，调用方会把「尺寸一致」读成「校验通过」',
      )
      assert.equal(unchecked.verified, false, '没验过就不得标记 verified')
      assert.equal(unchecked.payloadText, '带载荷的正文', '标注诚实不等于不给正文')

      const noPayload = await store.readRecord(ids.withoutPayload, { verifyHash: true })
      assert.equal(noPayload.integrity, 'no-payload')
      assert.equal(noPayload.verified, true, '无载荷记录不存在「未校验」问题')
    } finally {
      store.close()
    }
  })
})
