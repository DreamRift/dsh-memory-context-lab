/**
 * P0 红色基线 R04：once-per-turn 在读取/装包完成前就占用，暂败后同轮无法重试。
 *
 * 判据来源：docs/dev-0.15.0/开发流程.md §7.2 R04。
 * 期望：读取暂败/取消/未确认呈现时释放（或只在确认呈现后 commit），同轮可重试；
 * 成功呈现后同轮仍只出现一次。**确认呈现**指宿主事件确认或下次来源 ID 对账，
 * 不是 next() 返回 enter，也不是磁盘 flush（两者需要分开验证）。
 *
 * 观察协议：三次调用都执行完再统一报告 defect，避免中间态缺失声明。
 * - 第一次：provider.read 抛 ETRANSIENT → 不注入；
 * - 第二次（同轮）：若 gate 未被失败占用 → 应注入；
 * - 第三次（同轮）：只有第二次真的注入过，才要求被 gate 挡住。
 *
 * 直接调用 createRecall（真实用例接口）与受控 MemoryProvider 替身。
 */
import { createRecall } from '../../src/v3/application/recall.mjs'
import { runP0Fixture } from './harness.mjs'

const ID = 'v3r-00000000000000c1'

await runP0Fixture({
  id: 'R04',
  controls: ['first.injectedFalse', 'first.providerReadReached'],
  // 本夹具在基线上只独立判定“失败后同轮重试”；“成功后只一次”需要 retry 先成立，
  // 由 P1 修复后的正式回归套件覆盖（见证据文档 R04 边界），不在红色基线里凑数。
  defects: ['retry.sameTurnInjects'],
}, async (t) => {
  let reads = 0
  const provider = {
    async search() {
      const hit = { id: ID, score: 1 }
      return { display: [hit], pack: [hit], dropped: [], oovTerms: [] }
    },
    async read() {
      reads += 1
      if (reads === 1) throw new Error('ETRANSIENT 模拟读取暂败')
      return { text: '可恢复的正文答案' }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'p0-fake', tier: 'T1', live: true } },
  }
  const recall = createRecall({ provider, sessionKey: 'p0-r04' })
  const first = await recall({ query: '答案', turn: 1 })
  const second = await recall({ query: '答案', turn: 1 })
  const third = await recall({ query: '答案', turn: 1 })

  t.control('first.injectedFalse', first.injected === false, '第一次读取暂败不应注入')
  t.control('first.providerReadReached', reads >= 1, '第一次失败必须发生在 provider.read；实际 reads=' + reads)
  t.observe('calls', {
    first: { injected: first.injected, reason: first.reason ?? null },
    second: { injected: second.injected, reason: second.reason ?? null },
    third: { injected: third.injected, reason: third.reason ?? null },
    reads,
  })

  const retryOk = second.injected === true
  t.defect('retry.sameTurnInjects', retryOk, true, '读取暂败后同回合重试必须能进入装包')

  // 观察（非 defect）：第三次是否被成功后的 gate 挡住。
  // 基线第二次未成功，第三次 false 不能反证“成功后只一次”；该契约由 P1 修复后的
  // 正式回归套件判定，不在这里把未走到算成 RED。
  t.observe('third.afterFailedRetry', { injected: third.injected, reason: third.reason ?? null })
})
