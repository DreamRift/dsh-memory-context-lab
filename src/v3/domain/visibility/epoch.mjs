/**
 * 可见性摘要（visibilityDigest，domain/visibility，G6b / R-2 / R-3 / R-4）。
 *
 * ## 它是什么
 * 判定缓存与重复计数的**可见性代际**：把「影响判定结果的输入」压成一个 16 位
 * FNV-1a 64 摘要。同一输入 ⇒ 同摘要（确定性）；任何影响可见性的变化 ⇒ 摘要变。
 *
 * ## 它不是什么（R-3，合同级隔离）
 * 它与观测合同的 `surface.epoch`（整数代际，用于前缀缓存观测）**不同源、不可比较、
 * 不参与种子判定**：那边是「投影变了没有」的计数，这边是「可见性输入有没有变」的
 * 指纹。两者不得互相赋值、互相比较或互相喂给对方的接口。
 *
 * ## 材料（全部只读、不含时间戳）
 * 活动面节点序列、空面下界、**contentGeneration / replaceGeneration**（R-2：`kind:'project'`
 * 投影如 image/offload 会改内容而不改节点 seq，只看节点 seq 会把「内容变了」当成「没变」）、
 * 凭证（id/目标/区间）、遗忘集、回执清除集、活动面上的恢复节点数、回注包登记、归档意图状态。
 *
 * ## 空面
 * 空活动面的最大 seq **显式定义为 -1**（不是 0、不是 null）：0 是合法的事件 seq。
 *
 * ## 纯 append 增量（R-2）
 * 只有「`replaceGeneration` 与 `contentGeneration` 都没变」且活动面只是在**尾部增长**
 * 且其余材料完全相同，才允许复用上一代际的判定缓存；任一条件不成立就整批重判。
 * 代际未知（null）时**不允许**复用——不可观测的投影变化不能假设没发生。
 */
import { VISIBILITY_DIGEST_VERSION } from '../../contracts/visibility.mjs'
import { RESTORE_SOURCE_FORM } from '../../contracts/sources.mjs'
import { fnv1a64Of } from '../../shared/fnv1a64.mjs'
import { resolveVisibilitySnapshot } from './snapshot.mjs'

/**
 * 活动面不可读时的摘要常量（**不是** 16 位 hex：它不冒充任何可比的代际）。
 * 消费者看到它就知道「这一代际没有可用的活动面证据」。
 */
export const VISIBILITY_UNAVAILABLE_DIGEST = 'unavailable'

/** 空活动面的最大 seq（显式 -1；0 是合法事件 seq，不能拿 0 当空）。 */
export const EMPTY_SURFACE_MAX = -1

function digestOfList(list) {
  return fnv1a64Of(list.join(','))
}

/**
 * 可见性代际（只读，无副作用）。
 * @param {object} raw 原始或已归一化的活动面快照
 * @returns {{ok:boolean, digest:string, nodes:number[], max:number, generations:object, parts:string[], ignoredShadows:number}}
 */
export function visibilityEpochOf(raw) {
  const resolved = resolveVisibilitySnapshot(raw)
  if (!resolved.ok) {
    return {
      ok: false,
      digest: VISIBILITY_UNAVAILABLE_DIGEST,
      nodes: [],
      max: EMPTY_SURFACE_MAX,
      generations: { contentGeneration: null, replaceGeneration: null },
      parts: [],
      ignoredShadows: 0,
    }
  }
  const snapshot = resolved.snapshot
  const nodes = snapshot.nodes
  let restoreNodes = 0
  for (const seq of nodes) {
    if (snapshot.events.get(seq)?.sourceForm === RESTORE_SOURCE_FORM) restoreNodes += 1
  }
  const voucherMaterial = snapshot.vouchers
    .map((voucher) => [
      voucher.voucherId,
      voucher.targetEventId === null ? '-' : voucher.targetEventId,
      voucher.startSeq === null ? '-' : voucher.startSeq,
      voucher.endSeq === null ? '-' : voucher.endSeq,
    ].join('|'))
    .sort()
  const registryMaterial = snapshot.registry === null
    ? ['none']
    : snapshot.registry
      .map((entry) => [
        entry.seq === null ? '-' : entry.seq,
        entry.bodyId === null ? '-' : entry.bodyId,
        entry.recordIds.join('+'),
      ].join('|'))
      .sort()
  // 顺序不是判定输入：节点摘要按升序规范形（归一化已排序，这里再 sort 一次自证）。
  const nodeMaterial = nodes.map(String).sort()
  const surfaceMax = nodes.length === 0 ? EMPTY_SURFACE_MAX : Math.max(...nodes)
  const parts = [
    'v:' + VISIBILITY_DIGEST_VERSION,
    'nodes:' + digestOfList(nodeMaterial),
    'max:' + surfaceMax,
    'gen:' + (snapshot.generations.contentGeneration === null ? 'unknown' : snapshot.generations.contentGeneration)
      + '/' + (snapshot.generations.replaceGeneration === null ? 'unknown' : snapshot.generations.replaceGeneration),
    'vouchers:' + digestOfList(voucherMaterial),
    'forgot:' + digestOfList([...snapshot.forgotten].sort()),
    'redact:' + digestOfList([...snapshot.redacted].sort()),
    'restore:' + restoreNodes,
    'registry:' + digestOfList(registryMaterial),
    'intent:' + snapshot.archiveIntent,
  ]
  return {
    ok: true,
    digest: fnv1a64Of(parts.join(';')),
    nodes: [...nodes],
    max: surfaceMax,
    generations: { ...snapshot.generations },
    parts,
    ignoredShadows: snapshot.ignoredShadows,
  }
}

/**
 * 纯 append 增量判定（R-2）：只有「代际整数且都没变 + 节点只是尾部增长 + 其余材料相同」
 * 才允许复用上一代判定。参数是两次 `visibilityEpochOf` 的结果。
 */
export function isPureAppendAdvance(previous, next) {
  if (previous === null || previous === undefined || next === null || next === undefined) return false
  if (previous.ok !== true || next.ok !== true) return false
  const prevGen = previous.generations
  const nextGen = next.generations
  if (!Number.isSafeInteger(prevGen.contentGeneration) || !Number.isSafeInteger(prevGen.replaceGeneration)) return false
  if (!Number.isSafeInteger(nextGen.contentGeneration) || !Number.isSafeInteger(nextGen.replaceGeneration)) return false
  if (prevGen.contentGeneration !== nextGen.contentGeneration) return false
  if (prevGen.replaceGeneration !== nextGen.replaceGeneration) return false
  // 节点用**集合包含**判定而不是位置前缀：宿主活动面是位置语义（replace 在原位置
  // splice），位置比较会把「纯 append」误判成变化。集合只增 + 其余材料相同才是纯 append。
  const prevNodes = previous.nodes
  const nextNodeSet = new Set(next.nodes)
  if (nextNodeSet.size < prevNodes.length) return false
  for (const seq of prevNodes) {
    if (!nextNodeSet.has(seq)) return false
  }
  const restMaterial = (result) => result.parts
    .filter((part) => !part.startsWith('nodes:') && !part.startsWith('max:'))
    .join(';')
  return restMaterial(previous) === restMaterial(next)
}
