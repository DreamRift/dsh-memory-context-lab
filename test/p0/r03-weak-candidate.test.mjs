/**
 * P0 红色基线 R03：极弱 T1/T2 候选经「各自第一名归一/名次」后变成高分，穿过装包阈。
 *
 * 判据来源：docs/dev-0.15.0/开发流程.md §7.2 R03：**排序与装包资格分离**。
 * 本夹具只断言「归一后的展示分不得直接充当装包资格」这一当前可观测事实；
 * 不把「用原始 BM25/RRF 分数直接卡阈值」写成定案——跨后端原始分未标定，
 * 资格判据需 P5 由用户/设计者拍板。
 *
 * 直接调用 T2 复合 provider 导出的纯函数 mergeHits（真实接口），不启动 Python/MCP。
 */
import { mergeHits } from '../../src/v3/adapters/retrieval/t2-isolated-provider.mjs'
import { runP0Fixture } from './harness.mjs'

const LOCAL_ID = 'v3r-00000000000000a1'
const EXT_A = 'v3r-00000000000000b1'
const EXT_B = 'v3r-00000000000000b2'

await runP0Fixture({
  id: 'R03',
  controls: ['fixture.displayThree'],
  defects: ['pack.weakCandidatesExcluded'],
}, async (t) => {
  const local = { display: [{ id: LOCAL_ID, score: 0.02 }], pack: [], dropped: [], oovTerms: [] }
  const external = [{ id: EXT_A, score: 0.01 }, { id: EXT_B, score: 0.009 }]
  const merged = mergeHits(local, external, { limit: 10, packMinScore: 0.5 })
  t.control('fixture.displayThree', merged.display.length === 3, '三路候选都应在展示面，实际 ' + merged.display.length)
  t.observe('display', merged.display.map((hit) => ({ id: hit.id, score: hit.score, rawScore: hit.rawScore ?? null })))
  t.observe('pack', merged.pack.map((hit) => ({ id: hit.id, score: hit.score, rawScore: hit.rawScore ?? null })))
  // 契约只要求：归一/名次分不能作为装包资格；候选是否最终入包由 P5 的资格判据决定。
  t.defect('pack.weakCandidatesExcluded', merged.pack.length, 0, '原始分均 <0.5 的弱候选不得因归一/名次自动进装包面')
})
