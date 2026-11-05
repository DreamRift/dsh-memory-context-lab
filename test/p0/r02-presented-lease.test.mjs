/**
 * P0 红色基线 R02：装包预算只容纳 2 条，hits/头部计数/读租约却按 10 条。
 *
 * 判据来源：docs/dev-0.15.0/开发流程.md §7.2 R02、§6.3、§P1。
 * 期望：presentedIds、计数、预算和租约只对应**实际呈现**的条目；header 按最终装包数计。
 *
 * 合成夹具：10 条同质记录 + 单 token 查询；用真实 attachV3Engine/T1/state.json。
 * 已知边界：只覆盖本进程回注路径；宿主最终投影不在本夹具。
 */
import { readSessionState } from '../../src/v3/adapters/storage/session-state.mjs'
import { withEngineSession } from './helpers/p0-stack.mjs'
import { runP0Fixture } from './harness.mjs'

const MARK = 'p0mark'
const COUNT = 10
const PREVIEW = 1750

function hitLineCount(text) {
  return String(text ?? '').split('\n').filter((line) => line.startsWith('· ')).length
}

await runP0Fixture({
  id: 'R02',
  controls: ['recall.injected', 'fixture.presentedTwo'],
  defects: ['hits.onlyPresented', 'header.presentedCount', 'lease.onlyPresented'],
}, async (t) => {
  const texts = Array.from({ length: COUNT }, (_, i) => MARK + ' 记录' + i + ' ' + '材料'.repeat(1000))
  await withEngineSession({
    id: 'p0-r02',
    seed(session) { for (const text of texts) session.pushUser(text) },
  }, async ({ engine, root, id }) => {
    const out = await engine.recallForInjection(id, MARK, {
      turn: 1, limit: COUNT, packMinScore: 0, previewChars: PREVIEW, queryMaxChars: 512,
    })
    const presented = hitLineCount(out.text)
    const header = String(out.text ?? '').split('\n')[0]
    const state = readSessionState(root, id)
    const leases = Array.isArray(state.readLease) ? state.readLease.map((row) => row.recordId) : []
    t.control('recall.injected', out.status === 'injected', '10 条命中应注入')
    t.control('fixture.presentedTwo', presented === 2, 'PREVIEW=' + PREVIEW + ' 时预算应只容纳 2 条，实际 ' + presented)
    t.observe('measured', { packCandidates: out.hits?.length ?? null, presentedLines: presented, omitted: out.omittedHits ?? null, header, leaseCount: leases.length })
    t.defect('hits.onlyPresented', out.hits.length, presented, 'hits 只含实际呈现条目')
    t.defect('header.presentedCount', /命中 \d+ 条/.test(header) && header.includes('命中 ' + presented + ' 条'), true, 'header 按最终装包数计')
    t.defect('lease.onlyPresented', leases.length, presented, '读租约只加在实际呈现条目上')
  })
})
