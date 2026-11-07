/**
 * M-03 守卫（0.15.4，P2）：摄入必须**事件级幂等**，且**不得按正文去重**。
 *
 * ## 缺陷（一次调查把它的性质查清楚了）
 *
 * 排查报告原本写成「同一事件被摄入两次，产生 2,876 条重复记录」。实测推翻了这个
 * 结论，同时暴露出一个更该守的性质：
 *
 *   - 本库 3,214 条记录里 `sourceEventId` 重复 **0 组** —— 事件级去重**已经天然成立**
 *     （断点推进 + 提交即不可变让重放不会落第二份）；
 *   - 正文 hash 重复 28 组 / 多出 122 条，但抽样看全部是**短操作摘要**
 *     （`[cwd: …]`、`The file … has been`、`(no new output)`），
 *     即**不同事件碰巧正文相同**。
 *
 * 所以「按正文 hash 去重」**不是修复，而是缺陷**：它会把两次真实发生过的相同操作
 * 合并成一条，等同于**篡改历史**。用户原先拍的「事件 ID + 正文 hash」里，后半句
 * 必须丢弃——这条守卫就是为了把「不得按正文去重」钉死。
 *
 * ## 修法
 *
 * `processTurnMany` 接受 `seenEventIds`（来源事件 → 记录 ID）。命中即
 * `status:'duplicate'`：不新建记录、不动库，但**断点要推进**（否则每次重启重扫）。
 * 读不到来源表时**不做幂等**（失败开放于「不误拦」方向——幂等是省重复，不是安全门）。
 *
 * ## 钉住的判据
 *
 * 1. 同一事件 ID 第二次进来 → `duplicate`，且**库里记录数不增**；
 * 2. 两个**不同**事件 ID、**完全相同正文** → 必须**都落库**（不得按正文合并）；
 * 3. `duplicate` 必须回传已有记录的 ID（调用方要能继续按 ID 引用）；
 * 4. `duplicate` 不参与镜像/索引（record 为 null，调用方不得读它）；
 * 5. 来源表不可读时不失败（不因此拒绝摄入）。
 *
 * ## 不适用条件
 *
 * - 不测断点推进（`v3-entry` 的 lastSeq 职责）。
 * - 不测跨进程并发去重（跨进程仍由写锁 + 提交即不可变兜底）。
 * - 不测正文真空串（metaOnly）的入库判定（既有守卫）。
 *
 * ## 变异自证
 *
 * 把幂等判据换成「正文 hash 相同即跳过」→ 用例 2 红（两个相同正文只落一条）；
 * 恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createProcessTurn } from '../src/v3/application/process-turn.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-m03-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { port } = await createSessionStorePort(root, 'session-m03')
  // 记录 ID 取 uuid 前 16 位十六进制，必须逐次唯一（固定 uuid 会让两条记录撞同一 ID，
  // 掩盖「是否真的各自落库」这条判据）。
  let n = 0
  const turn = createProcessTurn({
    store: port,
    clock: { now: () => 1000 },
    random: { uuid: () => String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000' },
    metrics: { counter() {}, observe() {} },
    ownSourceKinds: ['memory-lab3-surface'],
  })
  return { port, turn }
}

/** 构造一个最小合法 user 事件（带稳定事件 ID）。 */
function eventOf(id, text) {
  return {
    id,
    type: 'user',
    sessionKey: 'session-m03',
    at: 1792845000000,
    source: { kind: 'user', form: null },
  }
}

async function recordCount(port) {
  return (await port.listRecordIds()).length
}

test('M-03：同一事件 ID 第二次进来必须幂等（记录数不增）', async (t) => {
  const { port, turn } = await setup(t)
  const event = eventOf('evt-1', '同一条消息')

  const first = await turn.many({ items: [{ event, text: '同一条消息' }] })
  assert.equal(first[0].status, 'applied', '首次必须落库，实际：' + JSON.stringify(first[0]?.status))
  const countAfterFirst = await recordCount(port)

  // 第二次：把已有记录登记进来源表（真实路径由 composition 从 store 构建）
  const existingId = (await port.listRecordIds())[0]
  const seen = new Map([[event.id, existingId]])

  const second = await turn.many({ items: [{ event, text: '同一条消息' }], seenEventIds: seen })
  assert.equal(second[0].status, 'duplicate', '同一事件必须判 duplicate，实际：' + JSON.stringify(second[0]?.status))
  assert.equal(await recordCount(port), countAfterFirst, '幂等命中不得新增记录')
  assert.equal(second[0].recordId, existingId, 'duplicate 必须回传已有记录 ID')
  assert.equal(second[0].record, null, 'duplicate 不得携带新记录对象（调用方不得把它当新记录镜像/索引）')
})

test('M-03：不同事件 ID、完全相同正文必须都落库（严禁按正文去重）', async (t) => {
  const { port, turn } = await setup(t)
  const sameText = '[cwd: resolvedFrom="C:\\\\x"; cwdSource="workingDirectory"]'

  const results = await turn.many({
    items: [
      { event: eventOf('evt-a', sameText), text: sameText },
      { event: eventOf('evt-b', sameText), text: sameText },
    ],
  })
  assert.equal(results[0].status, 'applied')
  assert.equal(results[1].status, 'applied', '两个不同事件即使正文相同也必须各自落库')
  assert.notEqual(results[0].recordId, results[1].recordId, '必须是两条不同记录')
  assert.equal(await recordCount(port), 2, '正文相同不得被合并（那是篡改历史）')
})

test('M-03：没有来源表时不做幂等（不因此拒绝摄入）', async (t) => {
  const { port, turn } = await setup(t)
  const results = await turn.many({
    items: [{ event: eventOf('evt-x', '正文'), text: '正文' }],
    seenEventIds: null,
  })
  assert.equal(results[0].status, 'applied', '来源表不可读不应阻断摄入')
  assert.equal(await recordCount(port), 1)
})
