/**
 * P0 红色基线 R01：927 字记录的**尾部答案**被检索命中，但回注首部 160 字看不到答案。
 *
 * 判据来源：docs/dev-0.15.0/开发流程.md §7.2 R01 与 §P5；P0 只记录，不修运行代码。
 * 期望行为：命中窗口包含尾部事实，可按源 span 精确回读。
 *
 * control 与 defect 分离：检索命中是 control（必须 PASS）；回注窗口是否含尾部是 defect。
 * 合成夹具：正文由重复汉字填充，尾部放唯一 ASCII 标识符；不是真实会话数据。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createT1Provider } from '../../src/v3/adapters/retrieval/t1-provider.mjs'
import { createRecall } from '../../src/v3/application/recall.mjs'
import { createSessionStorePort } from '../../src/v3/adapters/storage/session-store-port.mjs'
import { runP0Fixture } from './harness.mjs'

const SESSION_KEY = 'p0-r01'
const RECORD_ID = 'v3r-00000000000a0001'
const TAIL = ' 尾部唯一答案 p0tail7f3a'
const BODY = '甲'.repeat(927 - TAIL.length) + TAIL

function record(text) {
  return {
    id: RECORD_ID,
    kind: 'operation',
    sessionKey: SESSION_KEY,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-p0-r01', sourceForm: 'tool/result', transactionId: 'tx-p0-r01' },
  }
}

await runP0Fixture({
  id: 'R01',
  controls: ['fixture.length927', 'search.hitsTail', 'recall.injected'],
  defects: ['recall.windowIncludesTail'],
}, async (t) => {
  t.control('fixture.length927', [...BODY].length === 927, '记录正文必须是 927 码点，实际 ' + [...BODY].length)
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p0-r01-'))
  const { port, store } = await createSessionStorePort(root, SESSION_KEY)
  try {
    await port.transaction([record(BODY)])
    const provider = createT1Provider({ port, store })
    const search = await provider.search('p0tail7f3a')
    t.control('search.hitsTail', search.display.some((hit) => hit.id === RECORD_ID), 'BM25 全文检索必须命中尾部标识符')
    const recall = createRecall({ provider, sessionKey: SESSION_KEY })
    const out = await recall({ query: 'p0tail7f3a', turn: 1, previewChars: 160, packMinScore: 0.01 })
    t.control('recall.injected', out.injected === true, '有可读命中应注入')
    t.observe('recall.textLength', out.text?.length ?? 0)
    t.defect('recall.windowIncludesTail', out.text.includes('p0tail7f3a'), true, '注入窗口必须包含被命中的尾部事实')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
