/**
 * G6b 未接线守卫（0.15.4）：把「可见片段去重是候选、不是生效功能」这件事钉死。
 *
 * ## 背景
 *
 * `createRecall` 支持 `visibility` + `dedupeVisible`，`src/v3/domain/visibility/` 也有
 * 一整套实现，但**没有任何生产方**接线：
 *
 * - `composition.mjs` 唯一的 `createRecall(...)` 调用点从不传这两个入参；
 * - 仓库里没有 `snapshotOf` 的生产方；
 * - 没有 `dedupeVisible` 设置项，用户无法开启。
 *
 * 于是整链在真实会话中**不可达**（A-06 的「上限不可达」、A-07 的「快照缺失时失败开放」、
 * A-11 的「整链未接线」都是这件事的三种投影）。
 *
 * ## 用户裁定（2026-11-06）
 *
 * **B：保留代码，文档登记，留待之后决定是否开发。** 不删、不接。
 *
 * ## 本守卫的职责
 *
 * 不是「证明去重能用」，而是**证明它没被误以为能用**：
 *
 * 1. 调用点不得传 `dedupeVisible` / `visibility`（一旦有人接了，这里先红，逼他
 *    同时补端到端证据与设置项，而不是悄悄让行为变化）；
 * 2. 不传时必须走默认值（`dedupeVisible=false`），即去重不生效；
 * 3. 传了非法值必须**失败关闭**（这是既有契约，顺带钉住，防止「静默当 false」）。
 *
 * ## 不适用条件
 *
 * - 不测去重算法本身（`v3-g6b-recall-dedupe` / `v3-g6b-visibility` 守候选实现）。
 * - 不判断「该不该开发」——那是用户的产品决定，代码不表态。
 *
 * ## 变异自证
 *
 * 在调用点加上 `dedupeVisible: true` → 用例 1 红；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRecall } from '../src/v3/application/recall.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const compositionPath = path.join(here, '..', 'src', 'v3', 'composition', 'composition.mjs')

test('G6b：composition 的 createRecall 调用点不得传 dedupeVisible / visibility', async () => {
  const raw = await readFile(compositionPath, 'utf8')
  // 去掉注释：调用点上方的说明文字**会**提到这两个名字，不能误判
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const calls = [...source.matchAll(/createRecall\(\{[^}]*\}/g)].map((m) => m[0])
  assert.equal(calls.length, 1, 'composition 里应恰有一个 createRecall 调用点，实际 ' + calls.length)

  const call = calls[0]
  assert.ok(!/dedupeVisible/.test(call), 'G6b 未接线：调用点不得传 dedupeVisible（要接线请同时补端到端证据与设置项）')
  assert.ok(!/\bvisibility\s*:/.test(call), 'G6b 未接线：调用点不得传 visibility（没有 snapshotOf 生产方）')
})

/** 满足 MemoryProvider 端口契约的最小替身（缺任一必需方法会在装配期抛错）。 */
function fakeProvider() {
  return {
    search: async () => [],
    read: async () => null,
    health: async () => ({ ok: true }),
    capabilities: () => ({ backend: 'T1' }),
  }
}

test('G6b：不传 dedupeVisible 时默认关闭（去重不生效）', () => {
  const recall = createRecall({ provider: fakeProvider(), sessionKey: 'k' })
  // createRecall 返回可调用对象（召回入口本身）。不抛错即说明它走的是默认值路径，
  // 且**没有**因为「缺 visibility 端口」而失败——即去重确实没启用。
  assert.equal(typeof recall, 'function', 'createRecall 应返回可调用的召回入口')
})

test('G6b：显式开启但缺 visibility 端口必须失败关闭（不得静默忽略）', () => {
  assert.throws(
    () => createRecall({ provider: fakeProvider(), sessionKey: 'k', dedupeVisible: true }),
    /visibility|snapshotOf/,
    '开启去重却没有 visibility 端口时必须抛错，不能静默当成关闭',
  )
})
