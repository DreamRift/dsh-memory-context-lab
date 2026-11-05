/**
 * P2-11（0.15.1）：first-ingress 用整篇 `includes` 判「已外置」→ 正文提到标记即永久跳过 + 状态面误报。
 *
 * ## 缺陷
 * `isPreviewContent` 旧实现是 `textOfBlocks(blocks).includes(FIRST_INGRESS_TOKEN)`：只要正文里
 * **任何位置**出现 `[mcl-first-ingress]` 就算「已经外置」。两类真实数据会被它误伤：
 * 1. 用户贴了一段本插件的日志/说明（正文里天然含该标记）——**永久跳过外置**，大正文直接进模型；
 * 2. `surfaceStateOf` 据此报 `externalized`（状态面误报），观察面看到「已外置」但实际没外置。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-11（复现）；台账标「复现」。
 *
 * ## 修法
 * 只认**本机制自己生成的头部形态**（唯一真源 `FIRST_INGRESS_PREVIEW_HEAD_RE`）：首行必须以
 * token 开头并紧跟固定回执句式与体量数字。另把「幂等 ID 是否本次」的判定从整篇 `includes`
 * 收到**回执区**（首行到正文区之间），避免正文里碰巧含同一串 hex 把别人的预览认成本次的。
 *
 * ## 断言组
 * 1. 真正的外置正文（`previewBlocksOf` 产出）仍判为已预览（幂等不被破坏）；
 * 2. 正文**中段/尾部**提到标记 → 不判为已预览，且 `shouldExternalize` 仍返回 true；
 * 3. `surfaceStateOf` 对「正文提到标记」不报 externalized（状态面不误报）；
 * 4. 幂等 ID 只出现在正文区、不在回执区 → 不认领本次（externalized-other）。
 *
 * ## 不适用条件与已知边界
 * - 不改外置头文案（`previewBlocksOf` 逐字节不变，P7 的其他断言不受影响）。
 * - 只有「首行就是回执头」才算已外置；被别处改写过首行的正文属于 diverged，不在此条。
 *
 * ## 定点变异自证
 * `isPreviewContent` 退回整篇 `includes` → 组 2/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIRST_INGRESS_TOKEN,
  contentHashOf,
  isPreviewContent,
  previewBlocksOf,
  shouldExternalize,
  surfaceStateOf,
} from '../src/v3/domain/first-ingress/preview.mjs'

const BIG = '正文'.repeat(200)

const previewArgs = (content) => ({
  content,
  handle: 'v3r-0000000000000001',
  sourceEventId: 'dsh-7',
  externalId: 'fi-0123456789abcdef',
  surfaceContentHash: contentHashOf(content),
  toolName: 'bash',
  callId: 'call-1',
})

test('P2-11 真正的外置正文仍判为已预览（幂等不被破坏）', () => {
  const content = [{ type: 'text', text: BIG }]
  const preview = previewBlocksOf(previewArgs(content))
  assert.equal(isPreviewContent(preview), true)
  assert.equal(shouldExternalize(preview, { thresholdChars: 100 }), false, '已外置的正文不得重复外置')
})

test('P2-11 正文提到标记（中段/尾部）不算已外置，仍必须外置', () => {
  const mid = [{ type: 'text', text: BIG + '\n日志里出现了 ' + FIRST_INGRESS_TOKEN + ' 这个标记。' + BIG }]
  const tail = [{ type: 'text', text: BIG + FIRST_INGRESS_TOKEN }]
  assert.equal(isPreviewContent(mid), false, '标记在中段不是「已外置」')
  assert.equal(isPreviewContent(tail), false, '标记在尾部不是「已外置」')
  assert.equal(shouldExternalize(mid, { thresholdChars: 100 }), true, '提到标记的大正文仍必须外置')
})

test('P2-11 状态面不得把「提到标记」误报为 externalized', () => {
  const mentioned = [{ type: 'text', text: BIG + '\n提到了 ' + FIRST_INGRESS_TOKEN }]
  const state = surfaceStateOf({ content: mentioned, externalId: 'fi-0123456789abcdef', expectedSurfaceHash: contentHashOf(mentioned) })
  assert.notEqual(state, 'externalized', '没外置却报已外置就是状态面误报')
  assert.equal(state, 'original', '内容与原文 hash 一致 → original（可以外置）')
})

test('P2-11 幂等 ID 只在正文区出现 → 不认领本次（externalized-other）', () => {
  const content = [{ type: 'text', text: BIG }]
  const preview = previewBlocksOf(previewArgs(content))
  // 把回执区里的幂等 ID 抹掉，只留正文区一份 → 不是本次的预览
  const text = preview[0].text
  const bodyStart = text.indexOf('\n\n')
  const tampered = [{ type: 'text', text: text.slice(0, bodyStart).replaceAll('fi-0123456789abcdef', 'fi-ffffffffffffffff') + text.slice(bodyStart) }]
  assert.equal(isPreviewContent(tampered), true, '头部形态仍成立')
  assert.equal(
    surfaceStateOf({ content: tampered, externalId: 'fi-0123456789abcdef', expectedSurfaceHash: contentHashOf(tampered) }),
    'externalized-other',
    '回执区没有本次幂等 ID → 不认领',
  )
})
