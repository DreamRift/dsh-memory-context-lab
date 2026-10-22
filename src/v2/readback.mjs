import { V2SessionStore, v2SessionDirectoryFor } from './store.mjs'
import { EngineV2Error } from './errors.mjs'
import { getForgetIndex, isForgotten } from './disposition.mjs'
import { BYTES_PER_TOKEN } from './budget.mjs'
import { readForkMap } from './fork.mjs'
import { RECORD_KINDS } from './records.mjs'
import { parseStrictInteger } from '../core.mjs'

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
  // P-01（0.13.2-beta.5）：`open()` 的契约是「从未初始化过返回 null」。旧实现在
  // finally 里直接 `store.close()`，于是边界上抛的是一条内部 TypeError，
  // **盖住**了本该走到的「没有库」分支。这里如实抛业务错误（带 code），
  // 与 runtime-read 的 withReadableStore 同一种「没有库」语义。
  if (!store) {
    throw new EngineV2Error(`本会话没有 v2 库（从未启用），无法回读记录 ${id}。`, {
      code: 'ENOSTORE',
      details: { id, sessionId },
    })
  }
  try {
    // 主动遗忘守卫：遗忘记录不再按 ID 回读正文。账本是唯一权威；损坏的账本
    // 仍按已解析前缀过滤（读侧不因旁车损坏而硬失败），损坏披露由状态面负责。
    const forgetIndex = await getForgetIndex(v2SessionDirectoryFor(labRoot, sessionId))
    if (isForgotten(forgetIndex, id)) {
      throw new EngineV2Error(`记录 ${id} 已被主动遗忘，不再回读正文；如需恢复请先 forget undo`, {
        code: 'EFORGOTTEN',
        details: { id },
      })
    }
    const loaded = await store.readRecord(id, { verifyHash, maxBytes })
    if (!loaded?.ok) {
      // fork 迁移后的旧 ID 回源：父 namespace 的 ID 通过 fork-map 解析到子 ID。
      // 这条路径只在本地未命中时走，且映射来自本会话自己的迁移记录，不跨目录乱读。
      const mapped = await resolveViaForkMap(labRoot, sessionId, id)
      if (mapped) {
        // 时间侧信道（0.11.0）：墓碑判定必须在读取映射后的正文之前——先读后拒
        // 会让「已遗忘」与「不存在」在响应时间/磁盘访问上可区分。fork-map 本身
        // 只含 ID 映射，不涉及正文，故可以先读映射再判定。
        if (isForgotten(forgetIndex, mapped)) {
          throw new EngineV2Error(`记录 ${id}（fork 解析为 ${mapped}）已被主动遗忘，不再回读正文；如需恢复请先 forget undo`, {
            code: 'EFORGOTTEN',
            details: { id, mapped },
          })
        }
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
    if (!borrowed && store) store.close()
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
  // 损坏的 fork-map 不能静默当「没有映射」：那会把「解析不了」伪装成「记录不存在」。
  if (map?.unreadable) {
    throw new EngineV2Error(`fork 映射不可读（${map.error}）：无法判定记录 ${id} 的迁移来源`, {
      code: 'EFORKMAP',
      details: { id, error: map.error },
    })
  }
  const mapped = map?.mapping?.[id]
  return typeof mapped === 'string' ? mapped : null
}

/** 每页条数的上界（`listRecordsPage` 与 `/memory-lab history` 共用这一份）。 */
export const MAX_PAGE_SIZE = 2000

/**
 * 每页条数的**单一尺子**（O-01，0.13.2-beta.5）。
 *
 * 旧实现是 `Math.min(Math.max(Number(pageSize) || 200, 1), 2000)`——静默夹取，
 * 于是 `history 999999` 得到 2000 条，回执却只说「本页 N 条」，用户永远不知道
 * 自己要的数字被改过。项目自己的规矩写在 `budget.mjs` 的 `parseBudgetTokens` 里：
 * **超过上限必须显式报错；夹到上限会让调用方以为自己的参数生效了**。
 *
 * 这里同样只认严格十进制整数：小数、指数、非数字一律拒绝，不回落默认值。
 * 调用方拿到 `ok:false` 必须回用法错误，不得改成「用默认值继续」。
 */
export function resolvePageSize(raw, { fallback = 200 } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, value: fallback, clamped: false }
  const parsed = parseStrictInteger(raw)
  if (parsed === null || parsed < 1) {
    return {
      ok: false,
      error: `每页条数必须是 1..${MAX_PAGE_SIZE} 的整数（不接受小数、指数或非数字），收到 "${String(raw).trim()}"。`,
    }
  }
  if (parsed > MAX_PAGE_SIZE) {
    return {
      ok: false,
      error: `每页条数最多 ${MAX_PAGE_SIZE}，收到 ${parsed}。超过上限不会自动夹取——请显式给一个 ≤${MAX_PAGE_SIZE} 的值。`,
    }
  }
  return { ok: true, value: parsed, clamped: false }
}

/**
 * 稳定 ID 全序分页。afterId 传上一页 nextAfter；返回空页即翻完。
 * pageSize 走 {@link resolvePageSize} 的同一把尺子；非法值退回默认值而不是静默夹取。
 */
export async function listRecordsPage(labRoot, sessionId, { pageSize = 200, afterId = null, kinds = null, store: borrowed = null } = {}) {
  const sizePlan = resolvePageSize(pageSize)
  // 原语层保持「总能翻页」的既有契约（翻页调用不因一个坏参数整条失败），但**必须披露**：
  // 被拒的请求如实写进 `pageSizeRejected`，绝不让调用方以为自己的数字生效了。
  // 「非法即回用法错误」的那一层是命令面（runtime-read 的 history 用同一个函数判定）。
  const size = sizePlan.ok ? sizePlan.value : 200
  const store = borrowed ?? await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
  // P-01：没有库时返回 null（与 `open()` 契约一致），由调用方如实说明。
  if (!store) return null
  try {
    // 遗忘记录不进列表：原始分页逐页拉取、过滤后补足一页可见条目；
    // forgottenCount 只计本页补页过程中被过滤的条数（逐页累计，非全库总数）。
    const forgetIndex = await getForgetIndex(v2SessionDirectoryFor(labRoot, sessionId))
    const visible = []
    let cursor = afterId
    let forgottenCount = 0
    let rawTotal = null
    let lastExamined = afterId
    for (;;) {
      const { entries, nextAfter, total } = store.listEntries({ afterId: cursor, limit: size, kinds })
      // total 语义沿用单批契约：从起始 afterId 起的剩余总数（含隐藏）。只在
      // 首个非空批次捕获——补页循环末尾的空批会把 total 报成 0，覆盖真实值。
      if (rawTotal === null && entries.length > 0) rawTotal = total
      if (entries.length === 0) {
        // 空批＝目录翻完：nextAfter 归 null（hasNextPage false），与原分页契约一致。
        cursor = null
        break
      }
      let overflowAt = -1
      for (let i = 0; i < entries.length; i += 1) {
        if (visible.length >= size) {
          overflowAt = i
          break
        }
        const entry = entries[i]
        lastExamined = entry.id
        if (isForgotten(forgetIndex, entry.id)) {
          forgottenCount += 1
          continue
        }
        visible.push(entry)
      }
      // 游标停在已检视的最后一条；未检视者留给下一页，不跳过也不重复。
      cursor = lastExamined
      if (overflowAt !== -1) break
      if (visible.length >= size) break
      if (nextAfter === null) {
        cursor = null
        break
      }
      cursor = nextAfter
    }
    const page = { entries: visible, pageSize: size, nextAfter: cursor, hasNextPage: cursor !== null, total: rawTotal ?? 0, forgottenCount }
    if (!sizePlan.ok) {
      page.pageSizeRejected = sizePlan.error
      page.requestedPageSize = String(pageSize)
    }
    return page
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
  // P-01：同上——没有库返回 null，不抛内部 TypeError。
  if (!store) return null
  try {
    const warnings = []
    const entries = []
    const claimed = new Set()
    let used = 0
    let forgottenSkipped = 0
    // 工作集不装遗忘记录：显式点名如实警告，头部扫描静默跳过并计数披露。
    const forgetIndex = await getForgetIndex(v2SessionDirectoryFor(labRoot, sessionId))

    // 显式指定的记录：缺失不静默。
    for (const id of explicitRecordIds) {
      if (isForgotten(forgetIndex, id)) {
        warnings.push(`explicit-forgotten:${id}`)
        continue
      }
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
          header.verified = loaded.verified === true
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
      if (isForgotten(forgetIndex, entry.id)) {
        forgottenSkipped += 1
        continue
      }
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
            // BUG-012：这台扫描路径用 verifyHash:false 读载荷，hash 根本没核对。
            // 不能把 integrity 'ok'（只说明尺寸一致）写成「完整性 ok」；如实标注
            // 未验证，并带上独立的 verified=false，调用方不会误读成「已验证」。
            header.integrity = loaded.integrity === 'ok' && loaded.verified !== true
              ? 'ok(unverified)'
              : loaded.integrity
            header.verified = loaded.verified === true
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
      forgottenSkipped,
    }
  } finally {
    if (!borrowed) store.close()
  }
}
