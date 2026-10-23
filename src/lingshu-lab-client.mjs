import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import {
  coldRecordContent,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from './core.mjs'
import { EngineV2Error, InvalidArgumentError } from './errors.mjs'

const INITIALIZE_TIMEOUT_MS = 30_000
const TOOL_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 1_500
const STOP_KILL_WAIT_MS = 3_000

/**
 * Role view that makes `role:'tool-output'` records visible to `cg(read)`.
 *
 * The fixed 0.8.x store's default candidate pool excludes tool-output records;
 * archived cold nodes are written with exactly that role, so recall without
 * this view searches a pool that can never contain them (C-01). One explicit
 * view parameter is the whole fix — the records themselves keep their role,
 * layer, and tags.
 */
export const RECEIPT_VIEW = 'receipt'

function aborted(signal, label = '操作') {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new Error(`${label}已取消。`)
}

function throwIfAborted(signal, label) {
  if (signal?.aborted) throw aborted(signal, label)
}

function errorText(error) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? 'unknown error')
}

function timeoutResult(promise, milliseconds) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Minimal MCP stdio bridge dedicated to the disposable experiment. It is not
 * dsh-memory's bridge: that implementation writes a shared debug file, which
 * would violate the lab's "all test artifacts stay below this root" rule.
 */
export class DisposableJsonRpcBridge {
  constructor({ python, args, env, cwd, timeoutMs = TOOL_TIMEOUT_MS }) {
    this.options = { python, args, env, cwd, timeoutMs }
    this.child = null
    this.reader = null
    this.nextId = 1
    this.pending = new Map()
    this.ready = false
    this.disposed = false
    this.started = null
    this.stopping = null
    this.closed = null
    this.resolveClosed = null
  }

  async start(signal) {
    if (this.ready) return
    if (this.started) return this.started
    this.started = this.#start(signal)
    return this.started
  }

  async #start(signal) {
    throwIfAborted(signal, '启动隔离冷库')
    const child = spawn(this.options.python, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve })

    const settleClosed = (reason) => {
      this.#rejectAll(reason)
      this.reader?.close()
      this.reader = null
      this.resolveClosed?.(true)
    }

    child.once('error', (error) => settleClosed(new Error(`隔离冷库进程无法启动：${errorText(error)}`)))
    child.once('close', (code, signalName) => {
      settleClosed(new Error(`隔离冷库进程已退出（code=${String(code)} signal=${String(signalName)}）。`))
    })
    child.stdin?.on('error', (error) => {
      this.#rejectAll(new Error(`隔离冷库进程输入失败：${errorText(error)}`))
    })
    child.stderr?.on('data', () => {
      // Do not forward or persist stderr: it can contain experiment paths/content.
    })

    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      if (typeof message.id === 'number') this.#settle(message.id, message)
    })

    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      }, signal, INITIALIZE_TIMEOUT_MS)
      this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' })
      this.ready = true
    } catch (error) {
      await this.stop().catch(() => {})
      throw error
    }
  }

  async request(method, params, signal, timeoutMs = this.options.timeoutMs) {
    throwIfAborted(signal, method)
    if (this.disposed) throw new EngineV2Error('隔离冷库进程已关闭。', { code: 'EBACKENDCLOSED' })
    const child = this.child
    if (!child?.stdin?.writable) throw new EngineV2Error('隔离冷库进程不可写。', { code: 'EBACKENDCLOSED' })
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id, { error: { code: -32000, message: `${method} 超时` } })
      }, timeoutMs)
      const onAbort = () => this.#settle(id, { error: { code: -32800, message: `${method} 已取消` } })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#settle(id, { error: { code: -32001, message: errorText(error) } })
      }
    })
  }

  #write(message) {
    const stdin = this.child?.stdin
    if (!stdin?.writable) throw new EngineV2Error('隔离冷库进程不可写。', { code: 'EBACKENDCLOSED' })
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  #settle(id, message) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    if (message.error) {
      const error = message.error
      pending.reject(new Error(`灵枢调用失败：${errorText(error)}`))
    } else {
      pending.resolve(message.result)
    }
  }

  #rejectAll(reason) {
    for (const [, pending] of this.pending) {
      pending.cleanup()
      pending.reject(reason)
    }
    this.pending.clear()
  }

  async stop() {
    if (this.stopping) return this.stopping
    const stopping = this.#stop()
    this.stopping = stopping
    try {
      await stopping
    } catch (error) {
      if (this.stopping === stopping) this.stopping = null
      throw error
    }
  }

  async #stop() {
    this.disposed = true
    this.ready = false
    this.#rejectAll(new Error('隔离冷库进程已关闭。'))
    const child = this.child
    if (!child) return
    if (child.exitCode === null) {
      try { child.stdin?.end() } catch { /* already closed */ }
      const graceful = await timeoutResult(this.closed ?? Promise.resolve(true), STOP_GRACE_MS)
      if (!graceful && child.exitCode === null) {
        try { child.kill() } catch { /* process already exited */ }
        const killed = await timeoutResult(this.closed ?? Promise.resolve(true), STOP_KILL_WAIT_MS)
        if (!killed) throw new EngineV2Error('隔离冷库进程未能停止，已保留会话目录避免误删。', { code: 'ESTOPTIMEOUT' })
      }
    }
    this.reader?.close()
    this.reader = null
  }
}

/** Omit every root/token/attribution override inherited by the host process. */
export function buildIsolatedMdcgEnvironment({ parentEnv = process.env, storeRoot, lingshuPackageRoot, sessionId }) {
  const env = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key.startsWith('MDCG_') || key.startsWith('HIVE_') || key === 'DSH_SESSION_ID') continue
    if (key === 'PYTHONPATH' || key === 'PYTHONIOENCODING' || key === 'PYTHONUTF8' || key === 'PYTHONLEGACYWINDOWSSTDIO') continue
    env[key] = value
  }
  Object.assign(env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: path.resolve(lingshuPackageRoot),
    MDCG_ROOT: path.join(storeRoot, 'mdcg'),
    MDCG_STATE_ROOT: path.join(storeRoot, 'state'),
    MDCG_DATA_ROOT: path.join(storeRoot, 'data'),
    // Never name this directory "aux": Windows treats that basename as a device.
    MDCG_AUX_ROOT: path.join(storeRoot, 'auxroot'),
    MDCG_TENANT_REGISTRY: path.join(storeRoot, '_tenants_absent.json'),
    MDCG_TOKEN: '',
    MDCG_TOKEN_FILE: path.join(storeRoot, 'tokens.json'),
    MDCG_MASTER_KEY: '00'.repeat(32),
    MDCG_SUSTAIN: '0',
    MDCG_MCP_SURFACE: 'full',
    MDCG_TENANT: 'memory-context-lab',
    MDCG_ACTOR: 'dsh-memory-context-lab',
    MDCG_CLEARANCE: 'private',
    MDCG_SESSION: sessionId,
    MDCG_HARNESS: 'dsh-memory-context-lab',
    MDCG_UNIT: 'record',
    // The legacy local write identity is intentionally confined by every root
    // override above; no real token/keyring is read by this child process.
    MDCG_LEGACY_ENV_AUTH: '1',
    MDCG_CAN_WRITE: '1',
    MDCG_CAN_ADMIN: '0',
    MDCG_LEGACY_ENV_ADMIN: '0',
  })
  return env
}

export function mcpText(result) {
  if (!result || typeof result !== 'object') return ''
  const content = Array.isArray(result.content) ? result.content : []
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function parseToolResult(result) {
  const text = mcpText(result)
  if (result?.isError === true) throw new EngineV2Error(text || '隔离冷库拒绝了请求。', { code: 'EBACKENDREJECTED' })
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { text }
  }
}

/**
 * Normalize one `mdcg_get` answer into a three-state result.
 *
 * The isolated store distinguishes "missing" from "unreadable" with
 * `{ok:false, error:'not_found'}` rather than a bare null, and clips oversized
 * nodes at 2000 lines / 50 KiB with `truncated:true` plus `next_offset`. A
 * clipped answer is **not** a full body, so it must be reported as unverifiable
 * instead of being handed to a hash check that would silently compare a prefix.
 *
 * @returns `{ok:true, content, id}` for a complete read;
 *   `{ok:false, error:'truncated', nextOffset}` for a clipped read;
 *   `{ok:false, error:<reason>}` otherwise.
 */
export function normalizeNodeRead(view) {
  if (!view || typeof view !== 'object' || view.ok === false) {
    return { ok: false, error: view?.error ?? 'not_found' }
  }
  if (view.truncated === true) return { ok: false, error: 'truncated', nextOffset: view.next_offset ?? null }
  if (typeof view.content !== 'string') return { ok: false, error: 'no-content' }
  return { ok: true, content: view.content, id: view.id }
}

export class TemporaryLingshuClient {
  constructor({ bridge, sessionId }) {
    this.bridge = bridge
    this.sessionId = sessionId
    /** @type {{ supported: boolean|null, reason?: string }|null} receipt-view capability, filled by probeReceiptView */
    this.receiptView = null
  }

  static async create({ python = process.platform === 'win32' ? 'python' : 'python3', storeRoot, lingshuPackageRoot, sessionId, signal }) {
    const bridge = new DisposableJsonRpcBridge({
      python,
      args: ['-m', 'md_cg.mcp_server'],
      cwd: storeRoot,
      env: buildIsolatedMdcgEnvironment({ storeRoot, lingshuPackageRoot, sessionId }),
    })
    const client = new TemporaryLingshuClient({ bridge, sessionId })
    await bridge.start(signal)
    // Everything past start() owns a live child process. A rejection anywhere in
    // the handshake used to escape create() and leak that python process and its
    // pipes for the life of the host: only the missing-tools branch stopped the
    // bridge, so a tools/list timeout, an aborted signal or a broken pipe left an
    // orphan behind on every failed enable.
    try {
      const listing = await bridge.request('tools/list', {}, signal)
      const tools = Array.isArray(listing?.tools) ? listing.tools : []
      const names = new Set(tools.map((tool) => tool?.name))
      if (!names.has('mdcg_remember') || !names.has('cg') || !names.has('mdcg_get')) {
        throw new InvalidArgumentError('隔离冷库未暴露 mdcg_remember/cg/mdcg_get，已拒绝启用降温。', { code: 'EBACKENDUNAVAILABLE' })
      }
      // Startup capability probe: one read-only call, recorded for diagnostics
      // (C-08). Inconclusive results do not block enablement; every real recall
      // still carries the receipt view and fails explicitly if rejected.
      await client.probeReceiptView(signal)
      return client
    } catch (error) {
      await bridge.stop().catch(() => {})
      throw error
    }
  }

  async callTool(name, args, signal) {
    throwIfAborted(signal, `灵枢 ${name}`)
    const result = await this.bridge.request('tools/call', { name, arguments: args }, signal)
    throwIfAborted(signal, `灵枢 ${name}`)
    return parseToolResult(result)
  }

  async rememberArchived({ nodeId, text, range, tools, callIds, contentHash = null, chunk = null, chunkCount = null, signal }) {
    const result = await this.callTool('mdcg_remember', {
      node_id: nodeId,
      content: coldRecordContent({
        sessionId: this.sessionId,
        range,
        tools,
        callIds,
        text,
        contentHash,
        chunk,
        chunkCount,
      }),
      gated: false,
      layer: 'contextual',
      role: 'tool-output',
      tags: ['dsh-memory-context-lab', 'archived', 'cold'],
      importance: 0.55,
      session: this.sessionId,
    }, signal)
    // `ok:false` and `committed:false` come back as plain result fields, not as
    // MCP error text, so a lenient caller would sail right into the read-back
    // step and report a confusing hash mismatch for a write that never landed.
    // Observed case (@furongjun1999/dsh-memory 0.8.x autonomy gate): writing a
    // node id that already holds a DIFFERENT body returns
    // `ok:true, committed:false, moved_to:'review_queue'` — queued, not stored.
    // Treat both as an explicit write failure instead.
    if (result && typeof result === 'object' && result.ok === false) {
      throw new EngineV2Error(`冷库拒收写入（${result.error ?? 'unknown'}）：${result.hint ?? 'no hint'}`, { code: 'EBACKENDREJECTED', details: { reason: result.error ?? null } })
    }
    if (result && typeof result === 'object' && result.committed === false) {
      throw new EngineV2Error('冷库未提交写入（同 id 节点已持有不同正文，被排入复核队列而非落盘）', { code: 'ECOLDWRITECONFLICT' })
    }
    return result
  }

  /**
   * Read one cold node back by id.
   *
   * `mdcg_get` is the only read-back primitive that can distinguish "missing"
   * from "unreadable", and it clips oversized nodes instead of failing. Both
   * facts are handled in `normalizeNodeRead`: a clipped answer is reported as
   * unverifiable, never as a complete body.
   */
  async getNode(nodeId, signal) {
    return normalizeNodeRead(await this.callTool('mdcg_get', { node_id: nodeId }, signal))
  }

  /**
   * Query the isolated store with the receipt view (C-01).
   *
   * `view: RECEIPT_VIEW` is always sent: without it the default candidate pool
   * silently excludes `role:'tool-output'` records and every query answers
   * "no hits" against a store that actually holds the archive. A store too old
   * to accept the parameter fails the call; that failure surfaces upstream as
   * an explicit `unsupported`/`unavailable` status — never a silent fallback
   * to the official lingshu root.
   */
  async recall(query, signal, limit = 5) {
    return this.callTool('cg', {
      op: 'read',
      query,
      k: Number.isInteger(limit) && limit > 0 ? limit : 5,
      session: this.sessionId,
      view: RECEIPT_VIEW,
    }, signal)
  }

  /**
   * Read-only capability probe for the receipt view (C-01/C-08).
   *
   * Runs one cheap `cg(read)` with the view parameter at startup. It never
   * writes a probe node; if the store rejects the parameter the result says so
   * explicitly. An inconclusive probe (transient error) reports `null` and the
   * next real recall still carries the view.
   */
  async probeReceiptView(signal) {
    try {
      await this.callTool('cg', {
        op: 'read',
        query: 'probe',
        k: 1,
        session: this.sessionId,
        view: RECEIPT_VIEW,
      }, signal)
      this.receiptView = { supported: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      const unsupported = /view|参数|invalid|unexpected|unknown|not support/i.test(message)
      this.receiptView = unsupported
        ? { supported: false, reason: message.slice(0, 200) }
        : { supported: null, reason: message.slice(0, 200) }
    }
    return this.receiptView
  }

  async serviceInfo(signal) {
    return this.callTool('mdcg_service_info', {}, signal)
  }

  /**
   * Soft-delete one cold node this plugin itself wrote (P0-1 的「先删后写」).
   *
   * `mdcg_forget` moves the node to the store's `trash/` with an audit entry —
   * it is the only removal primitive the isolated store exposes, and it is
   * scoped to a single explicit `node_id`, so it can never widen into a
   * bulk delete. It is called **only** for nodes whose ids this plugin minted
   * and whose receipts were never committed: after a retry that had to re-mint
   * an ordinal, those bytes are unreferenced leftovers.
   *
   * Never throws into the archive path: a store that refuses (protected node,
   * autonomy tier that returns a change ticket instead of deleting, older
   * server without the tool) reports `{ ok: false, reason }` and the caller
   * counts the node as residue and says so in status.
   */
  async forgetNode(nodeId, signal, reason = '上下文降温：重试换号后清理无引用冷节点') {
    let result
    try {
      result = await this.callTool('mdcg_forget', { node_id: nodeId, reason }, signal)
    } catch (error) {
      return { ok: false, nodeId, reason: String(error?.message ?? error).slice(0, 200) }
    }
    if (result && typeof result === 'object') {
      if (result.ok === false) {
        return { ok: false, nodeId, reason: String(result.error ?? result.hint ?? '冷库拒绝删除').slice(0, 200) }
      }
      if (result.deleted === false || result.committed === false) {
        return { ok: false, nodeId, reason: String(result.reason ?? result.hint ?? '冷库未删除（可能转入复核）').slice(0, 200) }
      }
      return { ok: true, nodeId, result }
    }
    return { ok: true, nodeId, result }
  }

  async close() {
    await this.bridge.stop()
  }
}
