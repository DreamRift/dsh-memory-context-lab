/**
 * P2-16（0.15.1）：T2 镜像失败只能从计数读到；`mirrorRecord` 恒返回 `undefined`，`lastError` 单槽被覆盖。
 *
 * ## 缺陷
 * 1. `mirrorRecord()` 恒返回 `undefined`：调用方无法知道「这一次到底入队没有」，只能事后
 *    从 `mirrorStats()` 的计数差里倒推——并发摄入时计数会被别的任务掺和，倒推不可靠。
 * 2. `lastError` 是**单槽**：后一次失败覆盖前一次。真实序列常常是「队列满」→「审核被拒」→
 *    「未取到 ACCEPT」，状态面只剩最后一条，第一现场（队列满）被静默折叠。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-16（复现）。
 *
 * ## 修法
 * - `mirrorRecord` 返回 `{ enqueued, reason, label }`（入队 vs 各具体跳过原因）；
 * - 失败记录改为**有界历史** `recentFailures`（最近 `T2_MIRROR_FAILURE_KEEP` 条），
 *   `lastError` 保留为最新一条以兼容既有读面，状态面改为逐条列出。
 *
 * ## 断言组
 * 1. 正常入队 → `enqueued=true`；空正文 / 非法 ID / 已遗忘 → `enqueued=false` + 具体 reason；
 * 2. 关闭后入队 → reason=closed；
 * 3. 两次**不同原因**的失败 → `recentFailures` 同时保留两条（旧实现只剩一条）；
 * 4. 历史有界：超过 KEEP 条后只保留最近 KEEP 条。
 *
 * ## 不适用条件与已知边界
 * - 只改「可观测性」：镜像写入的语义、重试策略、失败不回滚本地提交都未变。
 * - `recentFailures` 是进程内状态，不落盘（重启后清空）。
 *
 * ## 定点变异自证
 * `mirrorRecord` 退回不返回 / 失败记录退回单槽 → 组 1/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createT2IsolatedProvider,
  T2_MIRROR_FAILURE_KEEP,
  T2_MIRROR_QUEUE_LIMIT,
} from '../src/v3/adapters/retrieval/t2-isolated-provider.mjs'

const LOCAL_A = 'v3r-aaaaaaaaaaaaaaaa'

function fakeT1() {
  return {
    async search() { return { display: [], pack: [], dropped: [], oovTerms: [] } },
    async read() { return { text: '', record: null } },
    async health() { return { healthy: true, indexedCount: 0 } },
    capabilities() { return { name: 'local-lexical-v3', tier: 'T1' } },
  }
}

function fakeClient({ onCall } = {}) {
  return {
    async callTool(name, args) {
      if (typeof onCall === 'function') return await onCall(name, args)
      if (args.op === 'write') return { ok: true, node_id: args.node_id, state: 'ACCEPT' }
      return { ok: true }
    },
  }
}

function make(opts = {}) {
  return createT2IsolatedProvider({
    root: '/tmp/t2-p2-16-' + Math.random().toString(16).slice(2),
    sessionKey: 'p2-16',
    t1: fakeT1(),
    client: fakeClient(opts),
  })
}

test('P2-16 mirrorRecord 必须回报本次结果，而不是恒 undefined', () => {
  const provider = make()
  const ok = provider.mirrorRecord({ id: LOCAL_A, payload: { text: '正文' } })
  assert.equal(ok?.enqueued, true, '入队必须如实回报（旧实现恒 undefined）')
  assert.equal(ok.reason, null)

  const noBody = provider.mirrorRecord({ id: LOCAL_A, payload: { text: '' } })
  assert.equal(noBody?.enqueued, false)
  assert.equal(noBody.reason, 'metadata-only', '空正文必须给出具体原因')

  const badId = provider.mirrorRecord({ id: 'bad-id', payload: { text: 'x' } })
  assert.equal(badId.reason, 'invalid-record')
})

test('P2-16 不同原因的失败不得互相覆盖（recentFailures 有界历史）', async () => {
  const provider = make({
    onCall: async (name, args) => {
      if (args.op === 'write') return { ok: true, node_id: args.node_id, state: 'REJECT' }
      return { ok: true }
    },
  })
  // 第一次写：审核被拒（reason=mirrorRejected）
  provider.mirrorRecord({ id: LOCAL_A, payload: { text: '正文' } })
  await new Promise((r) => setTimeout(r, 120))
  // 再制造一次不同原因：关闭 provider 后入队 → closed
  await provider.close()
  const closed = provider.mirrorRecord({ id: 'v3r-bbbbbbbbbbbbbbbb', payload: { text: '正文' } })
  assert.equal(closed.reason, 'closed')
  const stats = provider.mirrorStats()
  assert.ok(Array.isArray(stats.recentFailures), '状态面必须给出失败历史数组')
  assert.ok(stats.recentFailures.length >= 2, '两次不同原因都必须留着（旧实现只剩最后一条）：' + JSON.stringify(stats.recentFailures))
  assert.ok(stats.recentFailures.some((line) => /mirrorRejected/.test(line)), '审核被拒那条不得被覆盖')
  assert.ok(stats.recentFailures.some((line) => /closed/.test(line)), '关闭那条也必须在')
  assert.equal(stats.lastError, stats.recentFailures[stats.recentFailures.length - 1], 'lastError 仍是最新一条（向后兼容）')
})

test('P2-16 失败历史有界：不会无限增长', async () => {
  const provider = make()
  await provider.close()
  for (let i = 0; i < T2_MIRROR_FAILURE_KEEP + 5; i += 1) {
    provider.mirrorRecord({ id: 'v3r-' + String(i).padStart(16, '0'), payload: { text: '正文' } })
  }
  const stats = provider.mirrorStats()
  assert.ok(stats.recentFailures.length <= T2_MIRROR_FAILURE_KEEP, '历史必须有界（得到 ' + stats.recentFailures.length + '）')
  assert.equal(T2_MIRROR_QUEUE_LIMIT > 0, true)
})
