/**
 * P7 首次呈现的**记录端口**（adapters/storage，0.15.0 候选，默认关闭）。
 *
 * ## 为什么是适配器而不是新存储
 * §3.6 要求「原件先落库、读得回、再换预览」。本插件**已经**把每个 tool/result 事件
 * 摄入成一条 kind=operation 记录（process-turn.mjs 的 KIND_OF_TYPE；ID v3r-…，
 * provenance.sourceEventId = dsh-<seq>，正文经脱敏后写入 payload.text）。
 * 因此这里**只做查找 + 回读**：
 * - 不新建记录类型（RECORD_KINDS 不动：operation / message-user / message-assistant）；
 * - 不建第二套冷库（数据仍在既有 v3 会话目录）；
 * - 不复制「read/脱敏/forget/export/adopt」逻辑——回读走工具面 memory_context_read，
 *   命令面级联全部沿用既有实现。
 *
 * ## 先核验的摄入时序（重要）
 * 摄入是**后台异步**：v3 entry 的 pre-step 钩子在 await next() 之后 startIngest(entry, session)，
 * 不等待完成（entry/v3-entry.mjs 注释：钩子必须毫秒级返回）。所以「tool/result 刚落面、
 * 紧接着的那个 pre-step」里，记录**通常还没有**。本适配器不自己写记录（那会制造第二写者
 * 与重复记录），而是要求注入 ensureIngested({ sourceEventId, seq })：
 * - 传入 = 由接线方用**既有摄入路径**把这一条（最多到该 seq 的尾巴）同步补齐；
 * - 不传 = 只查已有记录；查不到就失败关闭（用例跳过，保留原文）。
 * 这是 P7 接线时的最小必要扩展：一个「补齐该事件」的同步入口，**不是**数据合同变更。
 *
 * ## 语句边界（G4）
 * - 记录正文可能已脱敏（隐私口径），因此预览以**记录正文**为准，而不是宿主原始字节；
 * - 两种 hash 分别命名：surfaceContentHash（宿主原文，调用方传入并复核）/ recordTextHash
 *   （已落库副本正文）——脱敏会改变字节，不要求两者相等，但**不得互相顶替**；
 * - 会话绑定：记录 sessionKey 与会话不符（导入/拷贝/跨会话 ID）一律失败关闭；
 * - 已遗忘记录：provenance 还能读（用于定位），但 readRecord 抛 EFORGOTTEN → 失败关闭；
 * - 重复摄入产生的多份拷贝：取字典序最小的记录 ID，句柄稳定（见 session-store-port）。
 */
import { V3ContractViolation, v3Error } from '../../contracts/errors.mjs'
import { isRecordId, TOOL_RESULT_ERROR_MARKER } from '../../contracts/records.mjs'
import { contentHashOf } from '../../domain/first-ingress/preview.mjs'
import { dshEventIdOfSeq } from '../host/dsh-host.mjs'

/**
 * 创建记录端口。
 *
 * @param {object} deps
 * @param {object} deps.store SessionStore 端口（需要 recordIdOfSourceEvent + readRecord）
 * @param {Function} [deps.ensureIngested] async ({ sourceEventId, seq, callId }) => void；用既有摄入路径补齐
 * @param {string} [deps.sessionKey] 会话键：给出时逐跳复核记录归属（跨会话 ID 失败关闭）
 * @returns {{persistOriginal: Function, readOriginal: Function, generationOf: Function}}
 */
export function createFirstIngressRecordPort({ store, ensureIngested, sessionKey } = {}) {
  if (store === null || typeof store !== 'object'
    || typeof store.recordIdOfSourceEvent !== 'function'
    || typeof store.readRecord !== 'function') {
    throw new V3ContractViolation('v3 first-ingress-records: 需要 SessionStore 端口（recordIdOfSourceEvent + readRecord）')
  }
  if (ensureIngested !== undefined && typeof ensureIngested !== 'function') {
    throw new V3ContractViolation('v3 first-ingress-records: ensureIngested 必须是函数或省略')
  }
  if (sessionKey !== undefined && (typeof sessionKey !== 'string' || sessionKey.length === 0)) {
    throw new V3ContractViolation('v3 first-ingress-records: sessionKey 必须是非空字符串或省略')
  }
  const boundKey = typeof sessionKey === 'string' && sessionKey.length > 0 ? sessionKey : null

  /** 会话归属复核：给出 sessionKey 时，记录必须是本会话的（跨会话 ID 不泄露、不越权）。 */
  function assertOwnedBySession(record, recordId) {
    if (boundKey === null) return
    if (record?.sessionKey !== boundKey) {
      throw v3Error('ESTORE_SESSION_MISMATCH', '记录 ' + recordId + ' 不属于本会话（会话绑定不一致；失败关闭）')
    }
  }

  /** 已落库副本正文的 hash（与宿主原文 hash 分开命名，不得互换）。 */
  function recordTextHashOf(text) {
    return typeof text === 'string' && text.length > 0 ? contentHashOf([{ type: 'text', text }]) : null
  }

  function generationOfText(text) {
    const hash = recordTextHashOf(text)
    return hash === null ? 'empty' : hash
  }

  async function resolveRecordId(seq, callId) {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new V3ContractViolation('v3 first-ingress-records: seq 必须是非负整数')
    }
    const sourceEventId = dshEventIdOfSeq(seq)
    if (ensureIngested !== undefined) await ensureIngested({ sourceEventId, seq, callId: callId ?? null })
    const recordId = await store.recordIdOfSourceEvent(sourceEventId)
    if (!isRecordId(recordId)) {
      throw v3Error('ERECORD_NOT_FOUND', '来源事件 ' + sourceEventId + ' 还没有可读记录（摄入未完成；失败关闭保留原文）')
    }
    return { recordId, sourceEventId }
  }

  return {
    /**
     * 定位并存取「这次工具结果」的既有记录。
     *
     * 入参真正被使用（P2-4 / G4）：
     * - contentHash：与记录正文比一次（相等=记录未脱敏）；不等是合法事实（脱敏），
     *   只如实回报 surfaceContentHashMatched，不据此拒绝；
     * - isError：记录里没有 isError 字段，错误态的唯一标记是 v3-entry 追加的
     *   TOOL_RESULT_ERROR_MARKER；调用方声明与记录不一致 → 显式拒绝（失败关闭），
     *   否则预览会用调用方的说法改写记录里的成功/失败口径；
     * - callId：记录合同不保存它；注入 ensureIngested 时转交给补齐入口，
     *   未注入则回报 callIdAttested=false（不使用不等于可以假装核验过）。
     *
     * @param {object} deps { seq, contentHash?, isError?, callId? }
     * @returns {Promise<{recordId: string, text: string, recordTextHash: string, surfaceEventId: string, surfaceHashMatched: boolean|null, surfaceContentHashMatched: boolean|null, recordErrorMarked: boolean, callIdAttested: boolean|null, generation: string}>}
     */
    async persistOriginal({ seq, contentHash, isError, callId } = {}) {
      if (contentHash !== undefined && contentHash !== null
        && (typeof contentHash !== 'string' || !/^[0-9a-f]{16}$/.test(contentHash))) {
        throw new V3ContractViolation('v3 first-ingress-records: contentHash 必须是 16 位小写十六进制或省略')
      }
      if (isError !== undefined && typeof isError !== 'boolean') {
        throw new V3ContractViolation('v3 first-ingress-records: isError 必须是布尔值或省略')
      }
      if (callId !== undefined && callId !== null && typeof callId !== 'string') {
        throw new V3ContractViolation('v3 first-ingress-records: callId 必须是字符串或省略')
      }
      const attestableCallId = typeof callId === 'string' && callId.length > 0 ? callId : null
      const resolved = await resolveRecordId(seq, attestableCallId)
      // 已遗忘 / 损坏 / 不存在一律原样抛出：调用方据此保留原文（不改面）。
      const record = await store.readRecord(resolved.recordId)
      assertOwnedBySession(record, resolved.recordId)
      // 来源身份复核：记录必须由**这条**来源事件摄入（导入/拷贝的记录 sourceEventId 为 null）。
      const provenanceEventId = record?.provenance?.sourceEventId
      if (provenanceEventId !== resolved.sourceEventId) {
        throw new V3ContractViolation('v3 first-ingress-records: 记录 ' + resolved.recordId + ' 的来源事件是 '
          + JSON.stringify(provenanceEventId) + '，不是 ' + resolved.sourceEventId + '（失败关闭，不复用别人的正文）')
      }
      const text = record?.payload?.text
      if (typeof text !== 'string' || text.length === 0) {
        throw v3Error('ERECORD_NOT_FOUND', '记录 ' + resolved.recordId + ' 没有可读正文（metaOnly 或空；不拿空壳冒充原件）')
      }
      const surfaceHashMatched = typeof contentHash === 'string'
        ? contentHashOf([{ type: 'text', text }]) === contentHash
        : null
      const recordTextHash = recordTextHashOf(text)
      const recordErrorMarked = text.endsWith(TOOL_RESULT_ERROR_MARKER)
      if (isError === true && recordErrorMarked !== true) {
        throw new V3ContractViolation('v3 first-ingress-records: 调用方声明 isError=true，但记录 ' + resolved.recordId
          + ' 的正文不含错误态标记（成功/失败口径不一致，拒绝按调用方说法渲染）')
      }
      if (isError === false && recordErrorMarked === true) {
        throw new V3ContractViolation('v3 first-ingress-records: 调用方声明 isError=false，但记录 ' + resolved.recordId
          + ' 的正文带错误态标记（成功/失败口径不一致，拒绝按调用方说法渲染）')
      }
      return {
        recordId: resolved.recordId,
        text,
        recordTextHash,
        surfaceEventId: resolved.sourceEventId,
        surfaceHashMatched,
        surfaceContentHashMatched: surfaceHashMatched,
        recordErrorMarked,
        callIdAttested: attestableCallId === null ? null : ensureIngested !== undefined,
        generation: generationOfText(text),
      }
    },

    /** 按 ID 回读（与 memory_context_read 同一条记录合同；已遗忘仍 EFORGOTTEN）。 */
    async readOriginal(recordId) {
      if (!isRecordId(recordId)) {
        throw v3Error('EINVALID_ID', '记录 ID 非法：' + JSON.stringify(recordId) + '（必须形如 v3r-<16 位小写十六进制>）')
      }
      const record = await store.readRecord(recordId)
      assertOwnedBySession(record, recordId)
      const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
      return { text, recordTextHash: recordTextHashOf(text), generation: generationOfText(text) }
    },

    /**
     * 遗忘代际（G4：forget/undo 在异步完成前后都复核）。
     *
     * digest 只由「这条记录当前能否读、正文 hash 是多少」派生：同一正文的 forget→undo
     * 回到同一 digest（不会把 undo 误判成内容变化），而 forget 改变可读性即改变 digest。
     * 读不到就给 readable:false + 具体错误码，不把「不知道」说成「没变」。
     */
    async generationOf(recordId) {
      if (!isRecordId(recordId)) {
        throw v3Error('EINVALID_ID', '记录 ID 非法：' + JSON.stringify(recordId))
      }
      try {
        const record = await store.readRecord(recordId)
        assertOwnedBySession(record, recordId)
        const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
        return { readable: text.length > 0, forgotten: false, digest: generationOfText(text) }
      } catch (error) {
        const code = error?.code ?? 'EINTERNAL'
        return { readable: false, forgotten: code === 'EFORGOTTEN', digest: 'unreadable:' + code }
      }
    },
  }
}
