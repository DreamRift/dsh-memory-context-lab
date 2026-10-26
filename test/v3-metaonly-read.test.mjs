/**
 * v3 metadata-only 回读守卫（H-15，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * P1 摄入合同 4.1.5 承诺 metadata-only 记录「可回读、可对账，不占检索位」，
 * 但 t1-provider.read 对空正文一律抛 **EFORGOTTEN**——既让「可回读」落空，
 * 又把「正文为空」伪装成「隐私面已遗忘」（错误码语义错位，调用方无法区分
 * 「这条被用户遗忘了」与「这条本来就没有正文」）。
 *
 * ## 判据
 * - metadata-only 记录可经 provider.read 回读，顶层 text 非空且如实说明原因；
 * - 真正的遗忘仍是 EFORGOTTEN（不因修复而放宽隐私面）；
 * - 非 metaOnly 却空正文 → ESTORE_CORRUPT（数据异常），不得冒充遗忘；
 * - 正常记录回读不变。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 provider.read 的返回口径；metadata-only 不进检索索引是另一条判据（已由
 * P1 端到端套件覆盖），本套件不重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function sessionOf(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: events.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
  }
}

async function withRuntime(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-metaonly-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-15 metadata-only 记录可回读，且不冒充遗忘（旧：EFORGOTTEN）', async () => {
  await withRuntime(async (root) => {
    const session = sessionOf('s-metaonly')
    const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-metaonly' })
    try {
      const normal = { seq: 0, type: 'user/message', at: 1, data: { content: [{ type: 'text', text: '正常正文' }] } }
      session.log.push(normal)
      const normalResult = await runtime.handleDshEvent(normal, '正常正文')
      const meta = { seq: 1, type: 'assistant/message', at: 2, data: { message: { content: [{ type: 'image', url: 'x' }] } } }
      session.log.push(meta)
      const metaResult = await runtime.handleDshEvent(meta, '', { metaOnly: true, metaReason: 'assistant 无可见文本块' })

      const readNormal = await runtime.provider.read(normalResult.recordId)
      assert.equal(readNormal.text, '正常正文')

      const readMeta = await runtime.provider.read(metaResult.recordId)
      assert.ok(readMeta.text.length > 0, '顶层 text 必须非空（PTC 形态可读）')
      assert.equal(readMeta.metaOnly, true)
      assert.match(readMeta.text, /metadata-only/)
      assert.match(readMeta.text, /assistant 无可见文本块/, '原因必须如实带回')

      // 隐私面不因修复而放宽
      await runtime.store.forget([normalResult.recordId])
      await assert.rejects(() => runtime.provider.read(normalResult.recordId), (error) => error?.code === 'EFORGOTTEN', '遗忘仍必须是 EFORGOTTEN')
    } finally {
      runtime.close()
    }
  })
})

test('H-15 非 metaOnly 却空正文 → ESTORE_CORRUPT（不得冒充遗忘）', async () => {
  await withRuntime(async (root) => {
    const session = sessionOf('s-empty')
    const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-empty' })
    try {
      const event = { seq: 0, type: 'user/message', at: 1, data: { content: [{ type: 'text', text: '' }] } }
      session.log.push(event)
      const result = await runtime.handleDshEvent(event, '')
      await assert.rejects(
        () => runtime.provider.read(result.recordId),
        (error) => error?.code === 'ESTORE_CORRUPT',
        '空正文且未标 metaOnly 是数据异常，不是遗忘',
      )
    } finally {
      runtime.close()
    }
  })
})
