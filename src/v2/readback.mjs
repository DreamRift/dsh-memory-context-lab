import { V2SessionStore } from './store.mjs'
import { EngineV2Error } from './errors.mjs'
import { BYTES_PER_TOKEN } from './budget.mjs'
import { readForkMap } from './fork.mjs'
import { RECORD_KINDS } from './records.mjs'

/**
 * 默认附带载荷的记录种类。
 *
 * 这里**必须引用 `RECORD_KINDS` 常量**：曾经写成下划线字面量（`'operation_call'`），
 * 而真实 kind 是点号（`'operation.call'`），`includes()` 恒为 false —— 默认调用
 * 永远不附带载荷，工作集里只有记录头，模型看不到任何正文。用常量就没法再拼错。
 */
export const DEFAULT_PAYLOAD_KINDS = Object.freeze([
  RECORD_KINDS.OPERATION_CALL,
  RECORD_KINDS.OPERATION_RESULT,
  RECORD_KINDS.ASSISTANT_TEXT,
  RECORD_KINDS.TURN_USER,
  RECORD_KINDS.PROJECTION_SPAN,
])

// ---------------------------------------------------------------------------
// 回读层：精确 ID 回读、稳定 ID 分页、最终 token 预算装包。
// 约束：hash 校验只做完整性检查（integrity），不是「事实验证」；
// 检索分数不是置信度；这里只提供确定性的按需读取原语。
// ---------------------------------------------------------------------------

/** 字节数 → token 估算；与 working-state 共用 budget.mjs 的口径。 */
function estimateTokens(bytes) {
  return Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN))
}

/**
 * 精确 ID 回读（稳定 ID → 记录 + 载荷）。
 * 回读是保真入口：未知 ID、未提交事务、载荷完整性失败都抛错，绝不静默返回坏内容。
 * verified 仅表示「载荷与登记哈希一致或本就无载荷」，不是「事实验证」。
 */
export async function readRecordById(labRoot, sessionId, id, { verifyHash = true, store: borrowed = null, maxBytes = null } = {}) {
  const store = borrowed ?? await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
  try {
    const loaded = await store.readRecord(id, { verifyHash, maxBytes })
    if (!loaded?.ok) {
      // fork 迁移后的旧 ID 回源：父 namespace 的 ID 通过 fork-map 解析到子 ID。
      // 这条路径只在本地未命中时走，且映射来自本会话自己的迁移记录，不跨目录乱读。
      const mapped = await resolveViaForkMap(labRoot, sessionId, id)
      if (mapped) {
        const retried = await store.readRecord(mapped, { verifyHash, maxBytes })
        if (retried?.ok) {
          assertIntegrityAcceptable(retried, { id: mapped, verifyHash })
          const verified = retried.integrity === 'no-payload' || (verifyHash && retried.integrity === 'ok')
          return { ...retried, verified, requestedId: id, resolvedVia: 'fork-map' }
        }
      }
      throw new EngineV2Error(`无法读取记录 ${id}：${loaded?.error ?? 'unknown'}`, {
        code: 'EREADNOTFOUND',
        details: { id, error: loaded?.error ?? null },
      })
    }
    assertIntegrityAcceptable(loaded, { id, verifyHash })
    // verified 仅当：无载荷，或本次确实执行了哈希校验且通过。
    // verifyHash=false 时不标记 verified——「没验过」不冒充「验过」。
    const verified = loaded.integrity === 'no-payload' || (verifyHash && loaded.integrity === 'ok')
    return { ...loaded, verified }
  } finally {
    // 借来的句柄由出借方关闭：同一会话目录在本进程内只允许一个句柄。
    if (!borrowed) store.close()
  }
}

/**
 * 载荷完整性是否可接受。
 *
 * `prefix` 只在有界读取时出现：本次只读了前 N 字节，因此**没有**对全文做哈希
 * 校验。它是诚实的「未校验」，不是坏内容，所以放行但由调用方标注 truncated；
 * 其余非 ok/no-payload 一律抛错，绝不静默返回坏内容。
 */
function assertIntegrityAcceptable(loaded, { id, verifyHash }) {
  if (!verifyHash) return
  if (loaded.integrity === 'ok' || loaded.integrity === 'no-payload' || loaded.integrity === 'prefix') return
  throw new EngineV2Error(`记录 ${id} 载荷完整性校验失败（${loaded.integrity}）`, {
    code: 'EPAYLOADHASH',
    details: { id, integrity: loaded.integrity },
  })
}

/**
 * 父 namespace 的 ID → 本会话 ID。没有映射文件或未命中时返回 null（不猜）。
 */
async function resolveViaForkMap(labRoot, sessionId, id) {
  const map = await readForkMap(labRoot, sessionId)
  const mapped = map?.mapping?.[id]
  return typeof mapped === 'string' ? mapped : null
}

/**
 * 稳定 ID 全序分页。afterId 传上一页 nextAfter；返回空页即翻完。
 * pageSize 截断在 [1, 2000]。
 */
export async function listRecordsPage(labRoot, sessionId, { pageSize = 200, afterId = null, kinds = null, store: borrowed = null } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 200, 1), 2000)
  const store = borrowed ?? await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
  try {
    const { entries, nextAfter, total } = store.listEntries({ afterId, limit: size, kinds })
    // 装满一页才假定还有更多；短页/空页即终止。
    const hasNextPage = entries.length === size && total > entries.length
    return { entries, pageSize: size, nextAfter, hasNextPage, total }
  } finally {
    if (!borrowed) store.close()
  }
}

/**
 * 最终 token 预算装包（工作集规划的读取原语）。
 *
 * 确定性策略：
 * 1. explicitRecordIds 先装（头 + 载荷），放不下的载荷记 warning 而非丢弃头部；
 * 2. 再按稳定 ID 逆序（最新优先）装剩余记录头部；
 * 3. verbatim 载荷只在「payloadKinds 命中且预算够」时附带；
 * 4. 永不隐式截断单条记录——放不下就停止并报告，调用方可分页细读。
 *
 * 返回 openCalls 供调用方做配对闭合判断；本函数不做任何自动写回。
 */
export async function packWorkingSet(labRoot, sessionId, {
  budgetTokens = 12_000,
  explicitRecordIds = [],
  payloadKinds = DEFAULT_PAYLOAD_KINDS,
  store: borrowed = null,
} = {}) {
  const store = borrowed ?? await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
  try {
    const warnings = []
    const entries = []
    const claimed = new Set()
    let used = 0

    // 显式指定的记录：缺失不静默。
    for (const id of explicitRecordIds) {
      const loaded = await store.readRecord(id, { verifyHash: true })
      if (!loaded?.ok) {
        warnings.push(`explicit-missing:${id}:${loaded?.error ?? 'unknown'}`)
        continue
      }
      claimed.add(id)
      const header = { id, kind: loaded.record.kind, seq: loaded.record.seq, fidelity: loaded.record.fidelity, payloadIncluded: false }
      used += estimateTokens(Buffer.byteLength(JSON.stringify(loaded.record), 'utf8'))
      if (loaded.payloadText !== null) {
        const payloadTokens = estimateTokens(Buffer.byteLength(loaded.payloadText, 'utf8'))
        if (used + payloadTokens <= budgetTokens) {
          used += payloadTokens
          header.payloadIncluded = true
          // 真的把正文带上：只标 `payloadIncluded` 而不附 `text`，调用方拿不到任何
          // 正文，「含载荷」就是一句无法兑现的声明。预算已经按它计过，带上不额外超支。
          header.text = loaded.payloadText
          header.integrity = loaded.integrity
        } else {
          warnings.push(`payload-deferred:${id}`)
        }
      }
      entries.push(header)
    }

    // 其余记录按稳定 ID 逆序装头部。
    const { entries: all } = store.listEntries({ limit: Number.MAX_SAFE_INTEGER })
    for (const entry of [...all].reverse()) {
      if (claimed.has(entry.id)) continue
      if (used >= budgetTokens) break
      const headerTokens = estimateTokens(256) // 头部预算按常量估计（kind/seq/refs 的稳定上界）
      used += headerTokens
      entries.push({ id: entry.id, kind: entry.kind, seq: entry.seq, fidelity: entry.fidelity, payloadIncluded: false })
      if (entry.payload && payloadKinds.includes(entry.kind)) {
        const loaded = await store.readRecord(entry.id, { verifyHash: false })
        if (loaded?.ok && loaded.payloadText !== null) {
          const payloadTokens = estimateTokens(Buffer.byteLength(loaded.payloadText, 'utf8'))
          if (used + payloadTokens <= budgetTokens) {
            used += payloadTokens
            const header = entries[entries.length - 1]
            header.payloadIncluded = true
            // 同上：标了「含载荷」就必须真的带上正文。
            header.text = loaded.payloadText
            header.integrity = loaded.integrity
          } else {
            used -= headerTokens
            entries.pop()
            break
          }
        }
      }
    }

    return {
      budgetTokens,
      usedTokens: used,
      entries,
      openCalls: store.openCalls(),
      warnings,
    }
  } finally {
    if (!borrowed) store.close()
  }
}
