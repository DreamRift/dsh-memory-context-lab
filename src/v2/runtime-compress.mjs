/**
 * v2 层级压缩域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：聚合凭证的预览/提交/状态、凭证分页展开，以及
 * 压缩与降温共用的依赖收集。函数体逐字搬移，语义零改动。
 *
 * ## 装配契约
 * `createCompressDomain({ adopt, factoryFor, labRoot, sessionIdOf, modelPhaseResolver, stageCompress })`。
 * `stageCompress` 缺省时回落真实的 `maybeStageCompress`（测试注入替身观察调用）。
 *
 * ## 不适用条件
 * 本域不改变工作状态卡形态：压缩只替换回执组，卡片由 card 域负责。
 */
import { randomUUID } from 'node:crypto'
import { PLUGIN_SOURCE_KIND } from '../core.mjs'
import { COMPRESS_SUBCOMMANDS, compressPreview, compressRun, compressStatus, describeHierarchyError, expandVoucher } from './hierarchy-coordinator.mjs'
import { AGG_VOUCHER_MARKER } from './agg-voucher.mjs'
import { v2SessionDirectoryFor } from './state.mjs'
import { getForgetIndex } from './disposition.mjs'
import { resolveReadTargets } from './identity-index.mjs'
import { withHostContract } from './command-result.mjs'

export function createCompressDomain({
  adopt,
  factoryFor,
  labRoot,
  sessionIdOf,
  modelPhaseResolver,
  stageCompress,
}) {
  /**
   * P3 层级压缩命令面：/memory-lab compress preview|run|status。
   * 两段式与 forget 一致：preview 不改任何状态；run 按事务序提交并可重复收口。
   */
  async function compressCommand(invocation, args) {
    const subcommand = (args[0] ?? '').toLowerCase()
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!COMPRESS_SUBCOMMANDS.includes(subcommand)) {
      return { kind: 'error', code: 'ECOMPRESSUSAGE', message: '用法：/memory-lab compress preview|run|status' }
    }
    if (subcommand === 'status') {
      try {
        const report = await compressStatus(await lightHierarchyDepsOf(invocation))
        return { kind: 'success', text: report.text }
      } catch (error) {
        return { kind: 'error', code: 'ECOMPRESSSTATE', message: describeHierarchyError(error) }
      }
    }
    const record = await adopt(invocation.agent)
    if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab on）。' }
    const deps = await compressDepsOf(record)
    try {
      const outcome = subcommand === 'preview' ? await compressPreview(deps) : await compressRun(deps)
      return { kind: 'success', text: outcome.text }
    } catch (error) {
      return { kind: 'error', code: 'ECOMPRESSRUN', message: describeHierarchyError(error) }
    }
  }

  async function expandCommand(invocation, args) {
    const voucherId = args[0]
    if (!voucherId) {
      return { kind: 'error', code: 'EEXPANDUSAGE', message: '用法：/memory-lab expand <凭证ID> [页码]（凭证ID 见 /memory-lab compress status）' }
    }
    try {
      const outcome = await expandVoucher(await lightHierarchyDepsOf(invocation), voucherId, args[1])
      return { kind: 'success', text: outcome.text }
    } catch (error) {
      return { kind: 'error', code: 'EEXPANDVOUCHER', message: describeHierarchyError(error) }
    }
  }

  /**
   * hierarchy-coordinator 依赖注入：表面与冷库都从已启用会话取（与 forget 相同的
   * adopt + factory 通道）。getRecordBody 走 withStore 事务读，isRecordVisible 用
   * 遗忘账本做同步过滤（展开页如实标注已遗忘成员）。
   */
  async function compressDepsOf(record) {
    /** 别名 → 记录 ID 的展开缓存（同一 run 里反复读同一成员）。 */
    const aliasCache = new Map()
    async function resolveRecordIds(target) {
      if (aliasCache.has(target)) return aliasCache.get(target)
      let ids = []
      try {
        const entries = await factoryFor(record).withStore((store) => store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries)
        const { resolved } = resolveReadTargets({ targets: [target], entries })
        ids = resolved[0]?.recordIds ?? []
      } catch {
        ids = []
      }
      aliasCache.set(target, ids)
      return ids
    }
    const sessionId = record.sessionId
    const sessionDir = record.directory
    const session = record.agent?.session
    const forgetIndex = await getForgetIndex(record.directory).catch(() => null)
    const forgotten = forgetIndex?.forgotten instanceof Map ? forgetIndex.forgotten : new Map()
    const kindById = new Map()
    return {
      sessionDir,
      eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
      surfaceNodes: () => (Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []),
      surfaceVoucherNodes: surfaceVoucherNodesOf(session),
      // 回执正文只印**冷节点 id**（`冷记录：mcl2-…`），而 store.readRecord 只认
      // `tXXXXXXXX-rYYYY` 形态的稳定记录 ID，传进去直接 EINVAL——层级压缩在真实
      // 库上从未跑通过（preview/run 全部失败在 memberViewOf 的第一次读）。
      // 这里用与 read/forget 同一套只读身份索引做别名展开：nodeId → 该单元的
      // span 记录（按 chunk 序）＋同单元配对记录。
      getRecordBody: async (recordId) => {
        const ids = await resolveRecordIds(recordId)
        if (ids.length === 0) return null
        const parts = []
        for (const id of ids) {
          const result = await factoryFor(record).withStore((store) => store.readRecord(id))
          if (!result?.ok) continue
          if (!kindById.has(recordId)) kindById.set(recordId, result.record?.kind ?? result.entry?.kind ?? null)
          if (typeof result.payloadText === 'string' && result.payloadText !== '') parts.push(result.payloadText)
        }
        return parts.length > 0 ? parts.join('\n\n') : null
      },
      getRecordKind: (recordId) => {
        // kind 只用于渲染标签；读不到就如实标「未知」，不猜（0.13.2-beta.2）。
        return kindById.get(recordId) ?? 'unknown'
      },
      isRecordVisible: (recordId) => {
        if (forgotten.has(recordId)) return false
        // 别名形态：任一展开记录被遗忘即视为不可见（与 read 的遗忘守卫同向）。
        for (const id of aliasCache.get(recordId) ?? []) {
          if (forgotten.has(id)) return false
        }
        return true
      },
      // T1/F-03：层级卡是否共享成员正文摘录。默认 false，只有显式开过才为真。
      shareL2Content: record.state.shareL2Content === true,
      // 模型相位（P4 依赖注入解析点）：所有宿主 LLM 契约风险收敛在
      // modelPhaseResolver 一个回调里。会话偏好未开或解析不出 stream 时返回
      // null → 协调器整体走程序档；解析失败同样按程序档处理（失败关闭）。
      modelPhase: await (async () => {
        if (record.state.compressModel !== true) return null
        try {
          const resolved = modelPhaseResolver
            ? await Promise.resolve(modelPhaseResolver(sessionId, { signal: record.abortSignal }))
            : null
          if (!resolved || typeof resolved.stream !== 'function') return null
          return resolved
        } catch {
          return null
        }
      })(),
      appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, sourceEventSeqs, text }) => {
        // 协调器显式给了来源事件就用之；否则按成员 seq 推导（仍是本段范围内的）。
        const given = (sourceEventSeqs ?? memberSeqs ?? []).filter((s) => Number.isSafeInteger(s) && s >= 0)
        const shadowed = given.length > 0 ? given : [startSeq]
        const event = session.append('user/message', {
          id: `surface-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: PLUGIN_SOURCE_KIND, form: 'memory-lab2-surface' },
        }, {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: shadowed,
        })
        return { seq: event?.seq }
      },
    }
  }

  function surfaceVoucherNodesOf(session) {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return []
    const found = []
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      if (event?.type !== 'user/message') continue
      const content = event.data?.content
      if (!Array.isArray(content)) continue
      const first = content.find((part) => part?.type === 'text')
      if (typeof first?.text === 'string' && first.text.startsWith(AGG_VOUCHER_MARKER)) {
        found.push({ seq, text: first.text })
      }
    }
    return found
  }

  /**
   * 只读轻依赖：compress status 与 expand 不需要 adopt（会话未启用也能查已有
   * 账本与凭证），只装 sessionDir、表面凭证视图与遗忘过滤。
   */
  async function lightHierarchyDepsOf(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
    const forgetIndex = await getForgetIndex(sessionDir).catch(() => null)
    const forgotten = forgetIndex?.forgotten instanceof Map ? forgetIndex.forgotten : new Map()
    return {
      sessionDir,
      surfaceVoucherNodes: surfaceVoucherNodesOf(invocation.agent.session),
      isRecordVisible: (recordId) => !forgotten.has(recordId),
    }
  }

  // G5：命令域导出统一套上宿主契约（见 v2/command-result.mjs）。
  return {
    ...withHostContract({ compressCommand, expandCommand }),
    compressDepsOf,
  }
}
