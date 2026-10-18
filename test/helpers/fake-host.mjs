/**
 * A faithful stand-in for the DSH session surface.
 *
 * The rules implemented here are transcribed from the installed host's own
 * `@deepseek-ai/dsh-session/surface` fold (0.2.0-rc.2), so a design that passes
 * these tests is one the real host accepts:
 *
 *   - every surface event requires a `surfaceOp`;
 *   - a replacement's endpoints must name earlier events that are currently on
 *     the surface, in order;
 *   - `sourceEventSeqs` must include every shadowed surface node, must be
 *     non-empty, unique, and earlier — and `assistant/message` may never carry
 *     it, so an assistant event can never be a replacement event;
 *   - a `tool/result` replacement must shadow exactly one node and may change
 *     only `message.content`;
 *   - surface node 0, when it is a `system/message`, may only be rewritten by a
 *     `system/message` over exactly that node.
 *
 * Tool-pairing balance is checked too, because the loop refuses unbalanced
 * ranges: an assistant node contributes one open call per `tool-call` block and
 * every `tool/result` closes one.
 */

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

export class SurfaceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SurfaceError'
  }
}

export class FakeSession {
  constructor({ id = 'session-test-0001' } = {}) {
    this.id = id
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.header = { config: { provider: 'fake', model: 'fake-model', maxTokens: 4096 } }
    this.context = { contextWindow: 100000 }
    this.balanced = [true]
  }

  get seq() {
    return this.events.length
  }

  get surface() {
    return { nodes: [...this.nodes], replaceGeneration: this.replaceGeneration }
  }

  eventAt(seq) {
    return this.events[seq]
  }

  snapshotEvents() {
    return [...this.events]
  }

  requestHeader() {
    return this.header
  }

  requestContext() {
    return this.context
  }

  setRoute(config) {
    this.header = { config }
  }

  /** Append one event with the host's surface validation applied. */
  append(type, data, opts = {}) {
    const seq = this.events.length
    const isSurface = SURFACE_TYPES.has(type)
    const op = opts.surfaceOp
    if (isSurface && op === undefined) throw new SurfaceError(`${type} requires a surfaceOp marker`)
    if (!isSurface && (op !== undefined || opts.sourceEventSeqs !== undefined)) {
      throw new SurfaceError(`${type} is not surface-eligible and cannot carry surface metadata`)
    }

    const shadowedSeqs = []
    if (isSurface && op !== 'append') {
      if (!op || op.op !== 'replace' || Object.keys(op).length !== 3) throw new SurfaceError('invalid replace surfaceOp')
      const { startSeq, endSeq } = op
      if (startSeq >= seq || endSeq >= seq) throw new SurfaceError('surface replace endpoints must reference earlier events')
      const startIdx = this.nodes.indexOf(startSeq)
      const endIdx = this.nodes.indexOf(endSeq)
      if (startIdx === -1) throw new SurfaceError(`surface replace: start seq ${startSeq} not found in surface`)
      if (endIdx === -1) throw new SurfaceError(`surface replace: end seq ${endSeq} not found in surface`)
      if (startIdx > endIdx) throw new SurfaceError('surface replace: start is after end')
      shadowedSeqs.push(...this.nodes.slice(startIdx, endIdx + 1))

      const sources = opts.sourceEventSeqs
      if (type === 'assistant/message' && sources !== undefined) {
        throw new SurfaceError('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
      }
      if (!Array.isArray(sources) || sources.length === 0) {
        throw new SurfaceError('sourceEventSeqs must be a non-empty array')
      }
      const seen = new Set()
      for (const source of sources) {
        if (!Number.isSafeInteger(source) || source < 0) throw new SurfaceError('sourceEventSeqs must contain non-negative safe integers')
        if (source >= seq) throw new SurfaceError(`sourceEventSeqs must reference earlier events: ${source} >= ${seq}`)
        if (seen.has(source)) throw new SurfaceError('sourceEventSeqs must not contain duplicates')
        seen.add(source)
      }
      const missing = shadowedSeqs.filter((value) => !seen.has(value))
      if (missing.length) throw new SurfaceError(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)

      if (type === 'tool/result') {
        if (shadowedSeqs.length !== 1) throw new SurfaceError('tool/result surface replacement must rewrite exactly one current node')
        const original = this.events[shadowedSeqs[0]]
        if (original?.type !== 'tool/result') throw new SurfaceError('tool/result surface replacement must target a current tool/result')
        const strip = (value) => ({ ...value, message: { ...value.message, content: null } })
        if (JSON.stringify(strip(original.data)) !== JSON.stringify(strip(data))) {
          throw new SurfaceError('tool/result surface replacement may change only content')
        }
      }
      if (startIdx === 0 && this.events[this.nodes[0]]?.type === 'system/message') {
        if (type !== 'system/message' || shadowedSeqs.length !== 1) {
          throw new SurfaceError('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
        }
      }
    }

    // 宿主 `Session.append(type, data, opts)` 只从 opts 取 `surfaceOp` /
    // `sourceEventSeqs`，其余键一律静默丢弃。夹具必须同语义：此前 `...opts`
    // 把 source 摊到事件顶层，于是「source 写错位置」在测试里看不出来，
    // 真实宿主却把它丢掉、让投影读 `data.source.kind` 崩掉整条历史（0.11.0）。
    const event = {
      type,
      seq,
      time: seq,
      data,
      ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
      ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    }
    this.events.push(event)
    if (isSurface) {
      if (op === 'append') {
        this.nodes.push(seq)
        this.balanced.push(this.#balanceTail() + this.#delta(event))
      } else {
        const startIdx = this.nodes.indexOf(op.startSeq)
        this.nodes.splice(startIdx, shadowedSeqs.length, seq)
        this.replaceGeneration += 1
        this.balanced.splice(startIdx, this.balanced.length - startIdx, ...this.#recomputeBalance())
      }
    }
    for (const value of this.balanced) {
      if (value < 0) throw new SurfaceError('tool-pairing balance went negative')
    }
    return event
  }

  #balanceTail() {
    return this.balanced.length ? this.balanced[this.balanced.length - 1] : 0
  }

  #recomputeBalance() {
    const next = []
    let open = 0
    for (const seq of this.nodes) {
      open += this.#delta(this.events[seq])
      if (open < 0) throw new SurfaceError(`tool-pairing balance: a tool/result at surface seq ${seq} has no matching call`)
      next.push(open)
    }
    return next
  }

  #delta(event) {
    if (event.type === 'assistant/message') {
      return (event.data?.message?.content ?? []).filter((block) => block?.type === 'tool-call').length
    }
    if (event.type === 'tool/result') return -1
    return 0
  }

  deriveEventMessage(event) {
    if (!event) return null
    if (event.type === 'user/message') return event.data
    if (event.type === 'tool/result') return event.data.message
    if (event.type === 'assistant/message' || event.type === 'system/message' || event.type === 'developer/message') {
      return (event.data?.message?.content?.length ?? 0) === 0 ? null : event.data.message
    }
    return null
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter(Boolean)
  }
}

/** Rough token meter; the real one is the host's, but only ratios matter here. */
export const fakeMeter = {
  estimateMessage(message) {
    if (!message) return 0
    if (message.role === 'system') return 0
    let tokens = 0
    for (const block of message.content ?? []) tokens += Math.ceil(String(block.text ?? '').length / 4) + 4
    return tokens + 4
  },
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({
      seq,
      heuristicTokens: fakeMeter.estimateMessage(session.deriveEventMessage(session.eventAt(seq))),
    }))
    return { totalTokens: nodes.reduce((sum, node) => sum + node.heuristicTokens, 0), nodes, baseline: { kind: 'estimated' } }
  },
}

/**
 * Cold-store stub that mirrors the isolated Lingshu client's contract,
 * including its habit of appending one trailing newline to stored content.
 */
export class FakeColdStore {
  constructor() {
    this.nodes = new Map()
    this.writes = 0
    this.recallPayload = { results: [] }
    this.failNextWrite = false
    this.clipReads = false
  }

  async rememberArchived({ nodeId, text, range, tools, callIds, contentHash, chunk = null, chunkCount = null }) {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new Error('fake cold store write failure')
    }
    this.writes += 1
    const header = [
      '# header',
      `- range: ${range.start}-${range.end}`,
      `- tools: ${tools.join(',')}`,
      `- calls: ${callIds.join(',')}`,
      ...(chunk === null ? [] : [`- chunk: ${chunk}/${chunkCount}`]),
      `- hash: ${contentHash}`,
    ].join('\n')
    // Mirror the real store's one appended trailing newline exactly.
    this.nodes.set(nodeId, { content: `${header}\n\n${text}\n` })
  }

  async getNode(nodeId) {
    const node = this.nodes.get(nodeId)
    if (!node) return { ok: false, error: 'not_found' }
    if (this.clipReads) return { ok: false, error: 'truncated', nextOffset: 0 }
    return { ok: true, content: node.content, id: nodeId }
  }

  async recall() {
    return this.recallPayload
  }

  async close() {}
}

/** Append one complete operation: an assistant tool-call plus its result. */
export function operation({ session, toolName = 'read', callId = 'call-1', args = '{"file":"a"}', result = 'x', turn = 1, step = 1, assistantText = '', assistantReasoning = '' }) {
  const content = []
  // Reasoning comes first, as adapters emit it: the block order the archived
  // body must preserve is reasoning → text → tool-call.
  if (assistantReasoning) content.push({ type: 'reasoning', text: assistantReasoning })
  if (assistantText) content.push({ type: 'text', text: assistantText })
  content.push({ type: 'tool-call', id: callId, name: toolName, arguments: args })
  session.append('assistant/message', {
    turn,
    step,
    message: { id: `m-${callId}`, role: 'assistant', content, source: { kind: 'model' } },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn,
    step,
    message: {
      id: `r-${callId}`,
      role: 'tool',
      content: [{ type: 'text', text: result }],
      source: { kind: 'tool', callId },
      toolCallId: callId,
    },
  }, { surfaceOp: 'append' })
}

/** Build a session with a system head, a user turn, and N completed operations. */
export function buildSession({ operations = 3, resultChars = 4000, id } = {}) {
  const session = new FakeSession({ id })
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '请阅读这些文件并总结' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })
  for (let index = 0; index < operations; index += 1) {
    operation({
      session,
      callId: `call-${index + 1}`,
      toolName: index % 2 === 0 ? 'read' : 'edit',
      args: `{"file":"file-${index + 1}.md","offset":${index}}`,
      result: `${'内容'.repeat(Math.ceil(resultChars / 2))}-${index}`,
      turn: index + 1,
      step: 1,
      assistantText: index === 0 ? '先读第一个文件。' : '',
    })
    session.append('turn/end', { turn: index + 1, reason: { kind: 'complete' } })
  }
  return session
}
