/**
 * v2 只读身份索引（0.10.1 S2a）：把「回执/工具面可见的标识」解析到记录 ID。
 *
 * 定位：`resolveForgetTargets`（disposition.mjs）承担遗忘的删除闭包与宽条件，
 * 语义是「谁可以被遗忘」；本模块只回答「这个别名指哪些记录」，供回读路径复用。
 * 两者共享同一种别名形态（nodeId 基名/分块名、callId、精确记录 ID），但**不复用
 * forget 的宽条件（kind=/before=）、硬保护与账本写入**——回读不扩大读取范围。
 *
 * 只读、纯函数、无 IO：输入是 store 的条目列表（`store.listEntries` 的 entries），
 * 输出是确定性解析结果。v1 导入指针的「读正文尽力匹配」路径刻意不迁入（那是
 * forget 的 find 语义，回读按 IDs 形态本就无正文可读）。
 *
 * 别名形态与闭包规则（与 forget 的单元闭包同口径，但只读）：
 * - 精确记录 ID（`tXXXXXXXX-rYYYY`）：直通，单元素集合。
 * - nodeId 基名（`mcl2-…`，或分块名 `mcl2-…_pN`）：展开为该单元全部**span 记录**
 *   （分块按 chunk 序），外加同单元的配对记录（OPERATION_CALL/OPERATION_RESULT）
 *   作来源索引；pair 只列 ID 不拼正文。
 * - callId：配对记录 + 其所属单元的 span 闭包。
 *
 * 诚实边界：别名展开**有上限**（ALIAS_EXPANSION_LIMIT）——一个基名下的记录数超限
 * 时如实报 `EALIASEXPANDLIMIT`，不静默截断；fork 映射解析仍在 readback 层
 * （`readRecordById` 的 fork-map 回退），本模块不知道 fork。
 */
import { EngineV2Error } from './errors.mjs'
import { parseRecordId, compareRecordIds, RECORD_KINDS } from './records.mjs'

export const ALIAS_EXPANSION_LIMIT = 64

/**
 * 单元的 span 分块序：inline.chunk 缺省为 1（首块），非法值按 1 处理并如实
 * 反映在排序稳定性上（chunk 相同按记录 ID 全序，保证确定性）。
 */
function chunkOrderOf(entry) {
  const chunk = entry?.inline?.chunk
  return Number.isSafeInteger(chunk) && chunk >= 1 ? chunk : 1
}

/**
 * 构建只读身份索引。entries 为 store.listEntries 的条目（只读形状）。
 *
 * 返回：
 * - byId：记录 ID → entry
 * - unitSpans：nodeId 基名 → 有序 span 记录 ID 数组（按 chunk 序，再按 ID 全序）
 * - unitPairs：nodeId 基名 → 配对记录 ID 集合（call/result；仅来源索引）
 * - byCallId：callId → 配对记录 ID 集合
 * - byNodeId：nodeId 原值/基名 → 基名（分块名归一到基名键）
 */
export function buildIdentityIndex(entries) {
  const byId = new Map()
  const unitSpans = new Map()
  const unitPairs = new Map()
  const byCallId = new Map()
  const byNodeId = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.id) continue
    byId.set(entry.id, entry)
    const nodeId = entry.inline?.nodeId
    if (typeof nodeId === 'string' && nodeId.length > 0) {
      const base = nodeUnitBaseOf(nodeId)
      if (!byNodeId.has(nodeId)) byNodeId.set(nodeId, base)
      if (!byNodeId.has(base)) byNodeId.set(base, base)
      if (entry.kind === RECORD_KINDS.PROJECTION_SPAN) {
        if (!unitSpans.has(base)) unitSpans.set(base, [])
        unitSpans.get(base).push(entry)
      } else if (entry.kind === RECORD_KINDS.OPERATION_CALL || entry.kind === RECORD_KINDS.OPERATION_RESULT) {
        if (!unitPairs.has(base)) unitPairs.set(base, new Set())
        unitPairs.get(base).add(entry.id)
      }
    }
    const callId = entry.refs?.callId
    if (typeof callId === 'string' && callId.length > 0) {
      if (!byCallId.has(callId)) byCallId.set(callId, new Set())
      byCallId.get(callId).add(entry.id)
    }
  }
  for (const [base, spans] of unitSpans) {
    spans.sort((a, b) => chunkOrderOf(a) - chunkOrderOf(b) || compareRecordIds(a.id, b.id))
    unitSpans.set(base, spans.map((entry) => entry.id))
  }
  return { byId, unitSpans, unitPairs, byCallId, byNodeId }
}

/**
 * nodeId 的单元基名：`<base>_pN` 分块形式去掉块号后缀。与 disposition 的
 * `nodeUnitBase` 同口径；本模块自持一份以避免把 forget 依赖拖进回读链。
 */
export function nodeUnitBaseOf(nodeId) {
  if (typeof nodeId !== 'string') return null
  const match = nodeId.match(/^(.+)_p\d+$/)
  return match ? match[1] : nodeId
}

/**
 * 解析回读目标：每个 target 得到它指向的记录 ID 有序数组与解析途径。
 *
 * 返回 { resolved, unresolved }：
 * - resolved：[{ requestedId, recordIds, resolvedVia }]，recordIds 按读取顺序
 *   （span 分块在前、按 chunk 序；pair 随后按 ID 全序）；resolvedVia ∈
 *   'record-id' | 'node-alias' | 'call-id'。
 * - unresolved：无法解析的目标原样列出（调用方决定显式报错口径）。
 * - 空别名（存在基名但 span 闭包为空）不算 unresolved：返回空 recordIds +
 *   resolvedVia 'node-alias'，由调用方按 EREADALIASEMPTY 显式报错。
 * - 超过 ALIAS_EXPANSION_LIMIT 的展开抛 EALIASEXPANDLIMIT（失败关闭，不截断）。
 */
export function resolveReadTargets({ targets, entries }) {
  const index = buildIdentityIndex(entries)
  const resolved = []
  const unresolved = []
  for (const target of Array.isArray(targets) ? targets : []) {
    if (typeof target !== 'string' || target.length === 0) {
      unresolved.push(target)
      continue
    }
    // 1) 精确记录 ID：直通。
    if (parseRecordId(target)) {
      if (index.byId.has(target)) {
        resolved.push({ requestedId: target, recordIds: [target], resolvedVia: 'record-id' })
      } else {
        unresolved.push(target)
      }
      continue
    }
    // 2) nodeId 基名/分块名：单元闭包 = span（chunk 序）+ pair（来源索引）。
    const base = index.byNodeId.get(target)
    if (base) {
      const spanIds = index.unitSpans.get(base) ?? []
      const pairIds = index.unitPairs.get(base) ?? new Set()
      const recordIds = [...spanIds, ...[...pairIds].sort(compareRecordIds)]
      if (recordIds.length > ALIAS_EXPANSION_LIMIT) {
        throw new EngineV2Error(
          `别名 ${target} 展开 ${recordIds.length} 条记录，超过上限 ${ALIAS_EXPANSION_LIMIT}；请按分块记录 ID 逐条回读`,
          { code: 'EALIASEXPANDLIMIT', details: { requestedId: target, count: recordIds.length } },
        )
      }
      resolved.push({ requestedId: target, recordIds, resolvedVia: 'node-alias' })
      continue
    }
    // 3) callId：配对记录 + 其单元闭包。
    const callHits = index.byCallId.get(target)
    if (callHits && callHits.size > 0) {
      const merged = new Set(callHits)
      for (const id of callHits) {
        const entry = index.byId.get(id)
        const callBase = entry?.inline?.nodeId ? nodeUnitBaseOf(entry.inline.nodeId) : null
        if (callBase && index.unitSpans.has(callBase)) {
          for (const spanId of index.unitSpans.get(callBase)) merged.add(spanId)
          for (const pairId of index.unitPairs.get(callBase) ?? []) merged.add(pairId)
        }
      }
      const recordIds = [...merged].sort(compareRecordIds)
      if (recordIds.length > ALIAS_EXPANSION_LIMIT) {
        throw new EngineV2Error(
          `callId ${target} 展开 ${recordIds.length} 条记录，超过上限 ${ALIAS_EXPANSION_LIMIT}`,
          { code: 'EALIASEXPANDLIMIT', details: { requestedId: target, count: recordIds.length } },
        )
      }
      resolved.push({ requestedId: target, recordIds, resolvedVia: 'call-id' })
      continue
    }
    unresolved.push(target)
  }
  return { resolved, unresolved }
}
