/**
 * T2 隔离 MCP 客户端（adapters/retrieval，0.14.0-beta.35）——dsh-memory 的
 * `md_cg.mcp_server` 的逐行 JSON-RPC 传输。
 *
 * 边界（设计文档《T2隔离MCP适配器设计》）：
 * - **只连隔离根**：`MDCG_ROOT` 指向本会话目录下的 `t2-mdcg/`，不碰正式灵枢根；
 * - **只用自己的凭据文件**：`MDCG_TOKEN_FILE` 指向隔离根内的 `tokens.json`，
 *   不读也不写 `~/.mdcg/_tokens.json`；
 * - 失败关闭：启动、协议、超时、进程退出任一异常都 reject；上层回 T1，
 *   绝不把「探测不出」当「可用」；
 * - 不新增模型可见工具：本客户端只供检索/镜像适配器内部使用。
 *
 * 传输可注入（`spawnImpl`），单元测试用 PassThrough 假子进程验证握手、超时、
 * 进程退出与协议错误，不需要真的启动 Python。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** MCP 版本：与 dsh-memory 0.9.10 的 mcp_server 实测一致。 */
export const T2_PROTOCOL_VERSION = '2024-11-05'

/** 单次工具调用默认超时。检索在 pre-step 的 awaited 路径上，必须有界。 */
export const T2_REQUEST_TIMEOUT_MS = 20000

/** 子进程关闭等待上限：不因为子进程卡住拖住插件 dispose。 */
const CLOSE_GRACE_MS = 1500

/** stderr 只留尾部摘要：诊断足够，且不让一个刷日志的子进程撑爆内存。 */
const STDERR_TAIL_CHARS = 4000

function asError(error, fallback) {
  if (error instanceof Error) return error
  const message = typeof error === 'string' && error.length > 0 ? error : fallback
  return new Error(message)
}

/**
 * 创建隔离 MCP 客户端。调用 `start()` 之后才可 `callTool`。
 *
 * @param {object} options
 * @param {string} options.root 隔离 MDCG_ROOT（必须是会话目录下的 `t2-mdcg`）
 * @param {string} options.repoRoot dsh-memory 包根（含 md_cg/）
 * @param {string} [options.python] Python 可执行文件（默认 python）
 * @param {string} options.tokenStoreFile 隔离令牌库路径（同时作为 MDCG_TOKEN_FILE）
 * @param {string} options.token 明文令牌（只经 env 传给子进程，不落日志）
 * @param {string} [options.policyFile] 写入闸门策略文件；缺省用包内 data/policy.json。
 *   不能沿用宿主全局 MDCG_POLICY_FILE：本机实测它可能指向不存在的
 *   ~/.dsh/.dsh-memory/policy.json，会让「握手成功」误判为「写入可用」。
 * @param {Record<string,string>} [options.env] 额外环境变量
 * @param {Function} [options.spawnImpl] 测试注入：与 node:child_process.spawn 同形
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.startupTimeoutMs]
 * @param {Function} [options.onStderr] 诊断回调（不包含令牌）
 */
export function createT2McpClient({
  root,
  repoRoot,
  python = 'python',
  tokenStoreFile,
  token,
  policyFile,
  env = {},
  spawnImpl = spawn,
  requestTimeoutMs = T2_REQUEST_TIMEOUT_MS,
  startupTimeoutMs = 30000,
  onStderr,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('t2-mcp-client: root 必传')
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('t2-mcp-client: repoRoot 必传')
  if (typeof tokenStoreFile !== 'string' || tokenStoreFile.length === 0) throw new Error('t2-mcp-client: tokenStoreFile 必传')
  if (typeof token !== 'string' || !token.startsWith('mdcg1.')) throw new Error('t2-mcp-client: token 形态非法（拒绝启动）')

  let child = null
  let rl = null
  let started = false
  let closing = false
  let exited = false
  let nextId = 1
  let stderrTail = ''
  let serverInfo = null
  const pending = new Map()

  function stderrOf() {
    return stderrTail
  }

  function failAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }

  function writeLine(message) {
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new Error('t2-mcp-client: 子进程 stdin 不可写（进程已退出？）')
    }
    child.stdin.write(JSON.stringify(message) + '\n', 'utf8')
  }

  function request(method, params, timeoutMs = requestTimeoutMs) {
    if (exited) return Promise.reject(new Error('t2-mcp-client: 子进程已退出'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('t2-mcp-client: ' + method + ' 超时（' + timeoutMs + 'ms）'))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer, method })
      try {
        writeLine({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(asError(error, 't2-mcp-client: 写入失败'))
      }
    })
  }

  function notify(method, params) {
    writeLine({ jsonrpc: '2.0', method, params })
  }

  function handleLine(line) {
    const text = String(line ?? '').trim()
    if (text.length === 0) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // 子进程可能往 stdout 写非 JSON 诊断；不把它当协议帧，也不崩客户端。
      return
    }
    if (message === null || typeof message !== 'object') return
    const id = message.id
    const entry = typeof id === 'number' ? pending.get(id) : undefined
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (message.error !== undefined && message.error !== null) {
      const code = message.error.code ?? -32603
      const messageText = message.error.message ?? JSON.stringify(message.error)
      entry.reject(new Error('t2-mcp-client: ' + entry.method + ' JSON-RPC 错误 ' + code + '：' + messageText))
      return
    }
    entry.resolve(message.result)
  }

  /**
   * 启动子进程并完成 MCP 握手。
   * @returns {Promise<{protocolVersion:string, serverInfo:object|null, tools:string[]}>}
   */
  async function start() {
    if (started) throw new Error('t2-mcp-client: 已启动，不得重复 start')
    started = true
    const childEnv = {
      ...process.env,
      ...env,
      PYTHONPATH: repoRoot,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      MDCG_ROOT: root,
      MDCG_TOKEN_FILE: tokenStoreFile,
      MDCG_TOKEN: token,
      // 写入闸门的策略文件：包内 data/policy.json 是随包发布的默认策略。
      // 不设时 dsh-memory 会去 ~/.dsh/.dsh-memory/policy.json 找，找不到即 fail-closed
      // （不落盘、不入审核队列）——那会把「T2 能握手」误判成「T2 能写」。
      MDCG_POLICY_FILE: policyFile ?? (repoRoot + '/data/policy.json'),
    }
    try {
      child = spawnImpl(python, ['-X', 'utf8', '-m', 'md_cg.mcp_server'], {
        cwd: repoRoot,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw asError(error, 't2-mcp-client: 启动子进程失败')
    }
    if (child === null || typeof child !== 'object' || child.stdout === null || child.stdin === null) {
      throw new Error('t2-mcp-client: spawnImpl 返回的子进程缺少 stdio')
    }

    child.on?.('error', (error) => {
      exited = true
      failAll(asError(error, 't2-mcp-client: 子进程错误'))
    })
    child.on?.('exit', (code, signal) => {
      exited = true
      failAll(new Error('t2-mcp-client: 子进程退出（code=' + String(code) + '，signal=' + String(signal) + '）'
        + (stderrTail.length > 0 ? '；stderr 尾部：' + stderrTail.slice(-800) : '')))
    })
    child.stderr?.on?.('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
      onStderr?.(stderrTail)
    })
    rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', handleLine)

    const timer = setTimeout(() => {
      failAll(new Error('t2-mcp-client: 启动握手超时（' + startupTimeoutMs + 'ms）'))
    }, startupTimeoutMs)
    timer.unref?.()
    try {
      const result = await request('initialize', {
        protocolVersion: T2_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-memory-context-lab', version: '0.14.0-beta.38' },
      }, startupTimeoutMs)
      if (result === null || typeof result !== 'object') {
        throw new Error('t2-mcp-client: initialize 返回形状非法')
      }
      serverInfo = result.serverInfo ?? null
      notify('notifications/initialized', {})
      const listed = await request('tools/list', {}, startupTimeoutMs)
      const tools = Array.isArray(listed?.tools)
        ? listed.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
        : []
      return { protocolVersion: result.protocolVersion ?? '', serverInfo, tools }
    } catch (error) {
      await close()
      throw asError(error, 't2-mcp-client: 启动失败')
    } finally {
      clearTimeout(timer)
    }
  }

  function describeError(value, fallback) {
  if (typeof value === 'string' && value.length > 0) return value
  if (value === null || value === undefined) return fallback
  try {
    const text = JSON.stringify(value)
    return text.length > 800 ? text.slice(0, 800) + '…' : text
  } catch {
    return fallback
  }
}

/**
 * 调用工具并解析结果。
 * MCP 结果固定是 `{content:[{type:'text',text}], isError}`；dsh-memory 把业务
 * 结果 JSON 编在 text 里。解析失败时返回 `{text}`，由调用方按形状判失败。
 */
async function callTool(name, args = {}, { timeoutMs = requestTimeoutMs } = {}) {
    if (!started) throw new Error('t2-mcp-client: 未 start')
    if (typeof name !== 'string' || name.length === 0) throw new Error('t2-mcp-client: 工具名必传')
    const result = await request('tools/call', { name, arguments: args }, timeoutMs)
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
    let parsed = null
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (result?.isError === true) {
      const message = describeError(parsed?.error ?? parsed?.message, text.slice(0, 500) || '工具报错')
      throw new Error('t2-mcp-client: 工具 ' + name + ' 报错：' + message)
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === false) {
      throw new Error('t2-mcp-client: 工具 ' + name + ' 拒绝：' + describeError(parsed.error ?? parsed.hint ?? parsed.verdict, '未知原因'))
    }
    return parsed ?? { text }
  }

  /** 关闭：先发 shutdown，超时后 kill；幂等。 */
  async function close() {
    if (closing) return
    closing = true
    try {
      if (!exited && child !== null && child.stdin !== null && !child.stdin.destroyed) {
        try {
          await Promise.race([
            request('shutdown', {}, 800).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 800)),
          ])
        } catch { /* shutdown 是尽力而为，退出兜底 */ }
      }
    } finally {
      rl?.close?.()
      if (child !== null && !exited) {
        try { child.stdin?.end?.() } catch {}
        const timer = new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS))
        await Promise.race([timer, new Promise((resolve) => child.once?.('exit', resolve))])
        if (!exited) {
          try { child.kill?.() } catch {}
        }
      }
      failAll(new Error('t2-mcp-client: 客户端已关闭'))
    }
  }

  return {
    start,
    callTool,
    close,
    stderrOf,
    get serverInfo() { return serverInfo },
    get closed() { return closing || exited },
  }
}

/**
 * 读取 MCP 结果里的节点正文（`cg(op='read')` 有两种形态：单节点视图 / 检索结果）。
 * 该函数只做形状适配，不解释业务；形状不认识返回 null。
 */
export function contentOfNodeView(result) {
  if (result === null || typeof result !== 'object') return null
  if (typeof result.content === 'string') return result.content
  if (result.node !== null && typeof result.node === 'object' && typeof result.node.content === 'string') {
    return result.node.content
  }
  return null
}


