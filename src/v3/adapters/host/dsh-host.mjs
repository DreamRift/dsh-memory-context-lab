/**
 * DSH 宿主适配器（adapters/host，M5 第一批）——HostSurface 端口对 DSH 插件 API 的实现。
 *
 * 宿主契约（2026-10-24 对 plugin/src/apply-commit.mjs 与 v2/history.mjs 核验）：
 * - 注入 = `session.append('user/message', { id, role:'user', content:[{type:'text',text}],
 *   source:{kind,form} }, options?)`；返回 { seq }；
 * - 表面替换 = options.`surfaceOp: { op:'replace', startSeq, endSeq }` +
 *   `sourceEventSeqs`（被遮蔽区间，审计与恢复都要用）；
 * - 确认面：`session.eventAt(seq)`、`session.surface.nodes`、`session.deriveMessages()`；
 * - DSH 事件类型（v2/history KIND_BY_TYPE）：user/message、assistant/message、tool/result、
 *   system/message…；source.kind 标写入者身份（P1 谁注入谁回收）。
 */
import { randomUUID } from 'node:crypto'

import { assertPort } from '../../ports/index.mjs'
import { validateEvent as contractsValidateEvent, V3ContractViolation, v3Error } from '../../contracts/index.mjs'

/** v3 表面形态名（新引擎新号；v1 的 memory-lab2-* 是禁用符号）。 */
export const V3_SURFACE_FORM = 'memory-lab3-surface'
export const V3_PLUGIN_SOURCE_KIND = 'dsh-memory-context-lab'

const DSH_USER_MESSAGE = 'user/message'

/**
 * 把 DSH 原生事件归一化为 v3 事件合同的类型封闭集。
 * @returns {{ ok: true, event } | { ok: false, errors: string[] }}
 */
export function normalizeDshEvent(raw, sessionKey) {
  if (raw === null || typeof raw !== 'object') return { ok: false, errors: ['DSH 事件必须是对象'] }
  // 宿主 seq 从 0 起（dsh-session SessionSeq 源码核验 2026-10-24）：合法域是非负安全整数
  if (!Number.isSafeInteger(raw.seq) || raw.seq < 0 || Object.is(raw.seq, -0)) return { ok: false, errors: ['DSH 事件缺 seq（append-only 序号是回读句柄的依据；合法域：非负安全整数）'] }
  const typeMap = {
    'user/message': 'user',
    'assistant/message': 'assistant',
    'tool/call': 'tool-call',
    'tool/result': 'tool-result',
  }
  const type = typeMap[raw.type]
  if (type === undefined) {
    return { ok: false, errors: ['DSH 事件类型不在 v3 归一化面：' + String(raw.type) + '（system/head 类不进记忆管线）'] }
  }
  const source = raw.data?.source ?? {}
  return validateShape({
    id: 'dsh-' + String(raw.seq ?? ''),
    type,
    sessionKey,
    at: Number.isFinite(raw.at) ? raw.at : 0,
    source: { kind: typeof source.kind === 'string' && source.kind.length > 0 ? source.kind : 'dsh', form: typeof source.form === 'string' ? source.form : null },
  })
}

function validateShape(candidate) {
  // 结构把关复用 contracts/events 的校验语义（这里不 import 是避免 adapters→contracts
  // 之外的隐藏形状分叉：直接调 contracts）
  return contractsValidateEvent(candidate)
}

/**
 * 创建 HostSurface 端口实现。
 * @param {object} deps { session: DSH session 对象（append/eventAt/surface.nodes/deriveMessages）, sessionKey }
 */
export function createDshHostAdapter({ session, sessionKey } = {}) {
  if (session === null || typeof session !== 'object' || typeof session.append !== 'function') {
    throw new V3ContractViolation('v3 dsh-host: 需要 DSH session 对象（含 append）')
  }
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 dsh-host: sessionKey 必须是非空字符串')
  }

  function appendReceipt(text, options) {
    try {
      const confirmation = session.append(DSH_USER_MESSAGE, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: V3_PLUGIN_SOURCE_KIND, form: V3_SURFACE_FORM },
      }, options)
      const seq = confirmation?.seq
      if (!Number.isInteger(seq) || seq < 1) {
        throw v3Error('EINTERNAL', 'DSH append 未返回 seq（宿主契约破坏，失败关闭）')
      }
      return seq
    } catch (error) {
      if (error?.code !== undefined) throw error
      const wrapped = v3Error('EINTERNAL', 'DSH append 失败：' + (error?.message ?? String(error)))
      throw wrapped
    }
  }

  const impl = {
    /** 表面操作：append 或 replace（replace 带 surfaceOp + sourceEventSeqs，遮蔽区间可审计）。 */
    async surfaceOp({ op, targetEventId, text } = {}) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new V3ContractViolation('v3 dsh-host: text 必须是非空字符串')
      }
      if (op === 'append') {
        return { seq: appendReceipt(text) }
      }
      if (op === 'replace') {
        if (!Number.isInteger(targetEventId) || targetEventId < 1) {
          throw new V3ContractViolation('v3 dsh-host: replace 的 targetEventId 必须是 ≥1 的 seq')
        }
        const seq = appendReceipt(text, {
          surfaceOp: { op: 'replace', startSeq: targetEventId, endSeq: targetEventId },
          sourceEventSeqs: [targetEventId],
        })
        // 确认面（apply-commit 同口径）：替换事件进面、目标出面
        if (typeof session.eventAt === 'function' && session.eventAt(seq) === undefined) {
          throw v3Error('EINTERNAL', '替换事件未进入活动面（宿主确认失败）')
        }
        if (Array.isArray(session.surface?.nodes) && session.surface.nodes.includes(targetEventId)) {
          throw v3Error('EINTERNAL', '目标 seq ' + targetEventId + ' 仍在活动面（替换未生效）')
        }
        return { seq }
      }
      throw new V3ContractViolation('v3 dsh-host: op 必须是 append/replace')
    },

    /** 原生事件流（归一化经 normalizeDshEvent；这里只给原始面，由调用方逐个归一）。 */
    async events() {
      const events = typeof session.events === 'function' ? session.events() : (session.events ?? [])
      return Array.isArray(events) ? events : []
    },

    async sessionInfo() {
      return { sessionKey }
    },

    async tools() { return [] },
    async commands() { return [] },
    async settings() { return {} },
  }

  return assertPort('HostSurface', impl)
}
