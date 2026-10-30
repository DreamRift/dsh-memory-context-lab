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
import { PLUGIN_SOURCE_KIND, validateEvent as contractsValidateEvent, V3ContractViolation, v3Error } from '../../contracts/index.mjs'

/** v3 表面形态名（新引擎新号；v1 的 memory-lab2-* 是禁用符号）。 */
export const V3_SURFACE_FORM = 'memory-lab3-surface'

/**
 * 插件自有 source.kind：**只有一个定义**，在 contracts/sources.mjs。
 * 这里保留同名 re-export 只为兼容既有 import（适配器层不复制字面量，
 * 否则「回注用哪个 kind」迟早与摄入跳过判据漂移）。
 */
export const V3_PLUGIN_SOURCE_KIND = PLUGIN_SOURCE_KIND

const DSH_USER_MESSAGE = 'user/message'

/** 归一化事件 ID 的前缀（H-01：断点反推与归一化必须用同一份形态，不得各写一遍）。 */
const DSH_EVENT_ID_PREFIX = 'dsh-'

/** 宿主 seq → v3 事件 ID（唯一生成点）。 */
export function dshEventIdOfSeq(seq) {
  return DSH_EVENT_ID_PREFIX + String(seq)
}

/** v3 事件 ID → 宿主 seq；不是本形态一律返回 null（不猜、不静默归一）。 */
export function seqOfDshEventId(id) {
  if (typeof id !== 'string' || !id.startsWith(DSH_EVENT_ID_PREFIX)) return null
  const raw = id.slice(DSH_EVENT_ID_PREFIX.length)
  if (!/^\d+$/.test(raw)) return null
  const seq = Number(raw)
  return Number.isSafeInteger(seq) ? seq : null
}

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
  // 宿主事件的时间字段是 `time`（dsh-session `append()`：{type, seq, time, data}），
  // 不是 `at`。旧实现只读 `at`，于是每条归一化事件的 at 恒为 0——记录本身用
  // clock.now() 另存 createdAt 才没暴露，但「事件时间」这个事实在入口就丢了。
  // `at` 保留为兼容旧夹具/旧格式（at 优先于 time）。B3-1：时间只在合法时保留，
  // 非法/缺失一律缺失并在返回值记 atReason——不再回落 0 伪造「1970 年发生」。
  const rawAt = Number.isFinite(raw.at) ? raw.at : raw.time
  const at = typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt >= 0 ? rawAt : undefined
  const atReason = at !== undefined ? undefined : (raw.at !== undefined || raw.time !== undefined ? 'invalid' : 'missing')
  const checked = validateShape({
    id: dshEventIdOfSeq(raw.seq),
    type,
    sessionKey,
    ...(at !== undefined ? { at } : {}),
    source: { kind: typeof source.kind === 'string' && source.kind.length > 0 ? source.kind : 'dsh', form: typeof source.form === 'string' ? source.form : null },
  })
  if (!checked.ok) return checked
  return atReason === undefined ? { ok: true, event: checked.event } : { ok: true, event: checked.event, atReason }
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

  function eventTextOf(event) {
    if (event === null || typeof event !== 'object') return null
    const message = event.data?.message
    const content = message?.content ?? event.data?.content
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      return text.length > 0 ? text : null
    }
    if (typeof event.data?.text === 'string' && event.data.text.length > 0) return event.data.text
    return null
  }

  function surfaceNodes() {
    return Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  }

  const impl = {
    /**
     * 表面操作：append 或 replace（replace 带 surfaceOp + sourceEventSeqs，遮蔽区间可审计）。
     *
     * 历史归档使用**区间 replace**：startSeq/endSeq 是 surface 节点；sourceEventSeqs 必须
     * 密集覆盖被遮蔽的全部节点（宿主 dsh-session 的 assertSourceEventReferences 判据）。
     * 单节点 replace 仍走 targetEventId，兼容既有卡片执行器。
     */
    async surfaceOp({ op, targetEventId, startSeq, endSeq, sourceEventSeqs, text } = {}) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new V3ContractViolation('v3 dsh-host: text 必须是非空字符串')
      }
      if (op === 'append') {
        return { seq: appendReceipt(text) }
      }
      if (op === 'replace') {
        let start = startSeq
        let end = endSeq
        let sources = sourceEventSeqs
        if (start === undefined && end === undefined) {
          if (!Number.isInteger(targetEventId) || targetEventId < 1) {
            throw new V3ContractViolation('v3 dsh-host: replace 的 targetEventId 必须是 ≥1 的 seq')
          }
          start = targetEventId
          end = targetEventId
          sources = [targetEventId]
        }
        if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
          // B3-11：不按数值判 start≤end——真实宿主（dsh-session lib/index.js:365-369，
          // 2026-10-30 核验）只按**活动面顺序**（nodes.indexOf 的 startIdx≤endIdx，下方已查）
          // 判 replace 区间；回执节点的 seq 恒大于其后面的正文节点（回执是后追加的），
          // 吸收回执（B3-11）的区间 replace 必然数值倒序。数值约束是旧实现自加的。
          throw new V3ContractViolation('v3 dsh-host: replace 的 startSeq/endSeq 必须是非负整数')
        }
        if (!Array.isArray(sources) || sources.length === 0
          || sources.some((seq) => !Number.isInteger(seq) || seq < 0)
          || new Set(sources).size !== sources.length) {
          throw new V3ContractViolation('v3 dsh-host: replace 的 sourceEventSeqs 必须是非空、无重复的非负整数数组')
        }
        const nodes = surfaceNodes()
        const startIdx = nodes.indexOf(start)
        const endIdx = nodes.indexOf(end)
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          throw new V3ContractViolation('v3 dsh-host: replace 的 startSeq/endSeq 不在当前活动面或顺序颠倒')
        }
        const shadowed = nodes.slice(startIdx, endIdx + 1)
        const missing = shadowed.filter((seq) => !sources.includes(seq))
        if (missing.length > 0) {
          throw new V3ContractViolation('v3 dsh-host: sourceEventSeqs 未覆盖被遮蔽节点：' + missing.join(', '))
        }
        const seq = appendReceipt(text, {
          surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
          sourceEventSeqs: [...sources],
        })
        // 确认面（apply-commit 同口径）：替换事件进面、被遮蔽节点全部出面
        if (typeof session.eventAt === 'function' && session.eventAt(seq) === undefined) {
          throw v3Error('EINTERNAL', '替换事件未进入活动面（宿主确认失败）')
        }
        const after = surfaceNodes()
        const stillThere = shadowed.filter((node) => after.includes(node))
        if (stillThere.length > 0) {
          throw v3Error('EINTERNAL', '被替换节点仍在活动面：' + stillThere.join(', '))
        }
        return { seq }
      }
      throw new V3ContractViolation('v3 dsh-host: op 必须是 append/replace')
    },

    /** 当前活动面节点（升序 seq）；历史归档按它选连续 span。 */
    async surfaceNodes() {
      return surfaceNodes()
    },

    /** 某个 surface 节点的当前正文；不存在/不是文本事件返回 null（不猜）。 */
    async surfaceTextAt(seq) {
      if (!Number.isInteger(seq) || typeof session.eventAt !== 'function') return null
      return eventTextOf(session.eventAt(seq))
    },

    /** 任意日志事件正文（恢复/核证用）；不存在返回 null。 */
    async eventTextAt(seq) {
      if (!Number.isInteger(seq) || typeof session.eventAt !== 'function') return null
      return eventTextOf(session.eventAt(seq))
    },

    /** 原生事件流（归一化经 normalizeDshEvent；这里只给原始面，由调用方逐个归一）。 */
    async events() {
      const events = typeof session.events === 'function' ? session.events() : (session.events ?? [])
      return Array.isArray(events) ? events : []
    },

    async sessionInfo() {
      const log = typeof session.events === 'function' ? session.events() : (session.events ?? session.log ?? [])
      let contextWindow = null
      if (Array.isArray(log)) {
        for (let i = log.length - 1; i >= 0; i -= 1) {
          if (log[i]?.type !== 'request/context') continue
          const window = log[i]?.data?.contextWindow
          if (Number.isFinite(window) && window > 0) contextWindow = window
          break
        }
      }
      const cwd = session.header?.cwd ?? session.meta?.cwd ?? (typeof session.cwd === 'string' ? session.cwd : null)
      return { sessionKey, cwd, contextWindow }
    },

    async tools() { return [] },
    async commands() { return [] },
    async settings() { return {} },
  }

  return assertPort('HostSurface', impl)
}
