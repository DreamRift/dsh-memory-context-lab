/**
 * 假 DSH session：实现真实 surface fold 的最小面（M0/M2 测试用）。
 *
 * 与宿主 dsh-session 的判据对齐：
 * - append 普通事件 → surface.nodes 追加 seq；
 * - append + surfaceOp{replace,startSeq,endSeq} → 必须覆盖被遮蔽的全部节点
 *   （sourceEventSeqs 密集包含），splice 成新 seq；
 * - 新 seq 必须大于 start/end；start/end 必须在当前 surface 中且顺序正确。
 *
 * 不模拟真实的 request/header/tool 结构；测试只关心 surface/seq/正文。
 *
 * 真实宿主的活动面**不含 tool/call**（调用记录只在 append-only 日志里，参数随
 * assistant/message 的 content 块出现）。B-3（0.14.0-beta.48）起夹具同口径：
 * pushToolCall 默认 log-only；需要旧形状的用例显式传 { onSurface: true }。
 */

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

export function createFakeSession({ cwd = 'C:\\workspace', contextWindow = 100000, id = 'session-fake' } = {}) {
  const log = []
  const bySeq = new Map()
  const surface = { nodes: [] }
  let nextSeq = 0

  function textEventText(event) {
    const content = event?.data?.message?.content ?? event?.data?.content
    if (Array.isArray(content)) {
      return content.map((part) => (part?.type === 'text' ? part.text : '')).join('')
    }
    return typeof event?.data?.text === 'string' ? event.data.text : ''
  }

  function append(type, data = {}, options = {}) {
    const op = options?.surfaceOp
    let seq = nextSeq
    if (op !== undefined && op !== null) {
      if (op.op !== 'replace') throw new Error('fake session: 只实现 replace surfaceOp')
      const nodes = surface.nodes
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error('fake session: replace range 不在 surface')
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      // 真实宿主规则：surface node 0 是系统提示，只能由 system/message 原节点改写；
      // 归档回执是 user/message，跨 node 0 的 replace 必然被拒绝（AUD48-04-04 的第二重机制）。
      const startEvent = bySeq.get(op.startSeq)
      if (startIdx === 0 && startEvent?.type === 'system/message') {
        throw new Error('fake session: surface replace 不得从 node 0（系统提示）开始')
      }
      const sources = Array.isArray(options.sourceEventSeqs) ? options.sourceEventSeqs : []
      const missing = shadowed.filter((node) => !sources.includes(node))
      if (missing.length > 0) throw new Error('fake session: sourceEventSeqs 未覆盖被遮蔽节点 ' + missing.join(','))
      if (op.startSeq >= seq || op.endSeq >= seq) throw new Error('fake session: replace 目标必须早于新 seq')
      const event = { type, seq, time: Date.now(), data, surfaceOp: { ...op }, sourceEventSeqs: [...sources] }
      log.push(event)
      bySeq.set(seq, event)
      surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq)
      nextSeq += 1
      return { seq }
    }
    const event = { type, seq, time: Date.now(), data }
    log.push(event)
    bySeq.set(seq, event)
    if (SURFACE_TYPES.has(type)) surface.nodes.push(seq)
    nextSeq += 1
    return { seq }
  }

  return {
    id,
    header: { cwd },
    log,
    surface,
    append,
    eventAt(seq) { return bySeq.get(seq) },
    deriveMessages() {
      return surface.nodes.map((seq) => bySeq.get(seq)).filter(Boolean)
    },
    textOf(seq) { return textEventText(bySeq.get(seq)) },
    pushUser(text) {
      // 真实 DSH user/message 正文在 data.content；assistant/tool 才在 data.message.content。
      return append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
    },
    /** 真实宿主的系统提示：会进活动面，但插件摄入封闭集不含 system/message（无 v3 记录）。 */
    pushSystem(text) {
      SURFACE_TYPES.add('system/message')
      try {
        return append('system/message', { message: { role: 'system', content: [{ type: 'text', text }] }, source: { kind: 'system' } })
      } finally {
        SURFACE_TYPES.delete('system/message')
      }
    },
    pushAssistant(text) {
      return append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] }, source: { kind: 'assistant' } })
    },
    pushToolCall(callId, name, args = {}, { onSurface = false } = {}) {
      // 真实形状：内容块在 assistant/message 里，tool/call 事件本身 log-only。
      if (onSurface === true) SURFACE_TYPES.add('tool/call')
      try {
        return append('tool/call', { message: { role: 'assistant', content: [{ type: 'tool-call', callId, name, arguments: JSON.stringify(args) }] }, callId, name, arguments: JSON.stringify(args) })
      } finally {
        if (onSurface === true) SURFACE_TYPES.delete('tool/call')
      }
    },
    /** 真实形状：assistant 消息同时带可见文本与工具调用块（B-1 的恢复面夹具）。 */
    pushAssistantWithToolCall(text, callId, name, args = {}) {
      const content = []
      if (typeof text === 'string' && text.length > 0) content.push({ type: 'text', text })
      content.push({ type: 'tool-call', callId, name, arguments: JSON.stringify(args) })
      return append('assistant/message', { message: { role: 'assistant', content }, source: { kind: 'assistant' } })
    },
    pushToolResult(callId, text) {
      return append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }] }, callId, isError: false })
    },
    pushContextWindow(value) {
      const event = { type: 'request/context', seq: nextSeq, time: Date.now(), data: { contextWindow: value } }
      log.push(event)
      bySeq.set(nextSeq, event)
      nextSeq += 1
      return event
    },
  }
}