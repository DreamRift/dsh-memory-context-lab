/**
 * T2 隔离探测与冒烟（adapters/retrieval，0.14.0-beta.35）。
 *
 * 探测顺序（任一失败 → 返回 `smokePassed:false` + 原因，由 negotiate 回 T1）：
 * 1. 隔离令牌（不存在则签发到隔离根）；
 * 2. 启动 `python -m md_cg.mcp_server`（独立 `MDCG_ROOT` / `MDCG_TOKEN_FILE`）；
 * 3. `initialize` + `tools/list`，必须含 `cg`；
 * 4. 冒烟：写一条六要素节点 → 按 ID 读回 → 尽力遗忘；
 * 5. 查询合同探针（0.15.0 P5）：写两条同词节点 → `cg read(query, k=2)` →
 *    验证 results 行含 node/score/state/reason，并记录 warning（k 越界信号）；
 *    探针失败**不推翻**基础冒烟，但能力协商把 searchQuery 降为 off（T1 回退）。
 *
 * **不复用全局 cg**：这里从头到尾只认隔离根。探测成功时把已握手的 client 交给
 * provider 工厂复用，避免同一会话启动两个 Python 进程；协商失败时由上层关闭。
 */
import { createHash } from 'node:crypto'

import { contentOfNodeView, createT2McpClient } from './t2-mcp-client.mjs'
import { ensureT2Token } from './t2-token.mjs'
import { T2_SMOKE_NODE_ID, T2_SMOKE_QUERY_NODE_IDS } from '../../contracts/t2.mjs'
import { T2_CONTRACT_ID } from '../../contracts/t2-contract.mjs'

export const T2_PACKAGE_NAME = '@furongjun1999/dsh-memory'

const SMOKE_MARKER = 'mcl-t2-smoke'
const QUERY_PROBE_MARKER = 'mclqueryprobe'

/** 冒烟正文：六要素各占一行，命中 dsh-memory 的 text 写入闸。 */
export function smokeContent() {
  return [
    '# 功能名：T2 隔离 MCP 冒烟节点',
    '# 生效条件：dsh-memory 已安装；Python 可用；隔离 MDCG_ROOT 可写',
    '# 子功能：验证 initialize / tools/list / cg write / cg read 四步',
    '# 执行：写入本节点后立即按 ID 读回，比对标记 ' + SMOKE_MARKER,
    '# 验证方式：读回正文包含标记即通过；失败关闭回 T1',
    '# 不适用条件：不是正式灵枢知识；不进入任何用户记忆；仅隔离实验根',
  ].join('\n')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 查询合同探针正文：六要素 + 共同词，供 cg read(query) 命中。 */
export function queryProbeContent(nodeId) {
  return [
    '# 功能名：T2 查询合同探针 ' + nodeId,
    '# 生效条件：隔离 MDCG_ROOT 可写；dsh-memory 已启动',
    '# 子功能：验证 cg read(query,k) 的返回行字段（node/score/state/reason）',
    '# 执行：共同词 ' + QUERY_PROBE_MARKER + '；本节点只用于合同探针，随后尽力遗忘',
    '# 验证方式：检索结果行数 ≤ k 且含 state/reason 键',
    '# 不适用条件：不是正式灵枢知识；不进覆盖率统计；不改变正式根',
  ].join('\n')
}

/**
 * cg read(query) 合同探针（0.15.0 P5）。
 * @returns {Promise<{passed: boolean, rows: number|null, fields: object|null, warning: string|null, reason: string|null}>}
 */
async function probeQueryContract(client, timeoutMs) {
  try {
    for (const nodeId of T2_SMOKE_QUERY_NODE_IDS) {
      await client.callTool('cg', {
        op: 'write',
        node_id: nodeId,
        content: queryProbeContent(nodeId),
        content_kind: 'text',
        session: 'mcl-smoke',
        tags: ['mcl-smoke'],
        importance: 0.1,
      }, { timeoutMs })
    }
    const result = await client.callTool('cg', {
      op: 'read',
      query: QUERY_PROBE_MARKER,
      session: 'mcl-smoke',
      k: 2,
    }, { timeoutMs })
    const rows = Array.isArray(result?.results) ? result.results : []
    const first = rows[0]
    const fields = first !== null && typeof first === 'object'
      ? {
        nodeId: typeof (first.node?.id ?? first.id) === 'string',
        score: typeof first.score === 'number' && Number.isFinite(first.score),
        state: Object.hasOwn(first, 'state'),
        reason: Object.hasOwn(first, 'reason'),
      }
      : null
    const rowsBounded = rows.length >= 1 && rows.length <= 2
    const passed = rowsBounded && fields !== null && fields.nodeId && fields.score && fields.state
    return {
      passed,
      rows: rows.length,
      fields,
      warning: typeof result?.warning?.code === 'string' ? result.warning.code : null,
      reason: passed
        ? null
        : (rowsBounded
          ? '结果行缺少 node/score/state 字段（契约不匹配）'
          : 'k=2 的检索返回 ' + rows.length + ' 行（空结果或超出 k）'),
    }
  } catch (error) {
    return { passed: false, rows: null, fields: null, warning: null, reason: errorText(error) }
  }
}

/** 工具面 + 版本 + 合同 ID 的稳定摘要（诊断/协商记录用，不涉及正文）。 */
export function schemaDigestOf(tools, version) {
  const surface = [...tools].sort().join(',')
  return createHash('sha256').update(surface + '|' + String(version) + '|' + T2_CONTRACT_ID).digest('hex').slice(0, 16)
}

/**
 * 探测隔离后端。
 *
 * @param {object} deps
 * @param {string} deps.root 会话隔离根下的 t2-mdcg
 * @param {string} deps.repoRoot dsh-memory 包根
 * @param {string} [deps.python]
 * @param {string} [deps.version] dsh-memory 包版本（探测结果记录用）
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {Function} [deps.spawnImpl] 测试注入
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<object>} described：始终是对象；失败时 smokePassed=false、带 error
 */
export async function probeT2Isolated({
  root,
  repoRoot,
  python = 'python',
  version = '',
  env = process.env,
  spawnImpl,
  timeoutMs = 30000,
} = {}) {
  const base = {
    name: T2_PACKAGE_NAME,
    version,
    tools: [],
    smokePassed: false,
    isolated: true,
    root,
    repoRoot,
    python,
  }
  let client = null
  let toolTimeout = timeoutMs
  try {
    const credentials = await ensureT2Token({ root, repoRoot, python, env })
    client = createT2McpClient({
      root,
      repoRoot,
      python,
      tokenStoreFile: credentials.tokenStoreFile,
      token: credentials.token,
      env,
      spawnImpl,
      startupTimeoutMs: timeoutMs,
      requestTimeoutMs: timeoutMs,
    })
    const started = await client.start()
    const tools = started.tools
    if (!tools.includes('cg')) {
      throw new Error('tools/list 缺 cg（实际：' + (tools.join(', ') || '空') + '）')
    }
    // 冒烟请求比启动短：探测在后台建库任务里，不能让单个卡死的写拖住整库。
    toolTimeout = Math.min(timeoutMs, 15000)
    const nodeId = T2_SMOKE_NODE_ID
    await client.callTool('cg', {
      op: 'write',
      node_id: nodeId,
      content: smokeContent(),
      content_kind: 'text',
      session: 'mcl-smoke',
      tags: ['mcl-smoke'],
      importance: 0.1,
    }, { timeoutMs: toolTimeout })
    const readBack = await client.callTool('cg', { op: 'read', node_id: nodeId }, { timeoutMs: toolTimeout })
    const text = contentOfNodeView(readBack)
    if (typeof text !== 'string' || !text.includes(SMOKE_MARKER)) {
      throw new Error('冒烟读回没有看到标记（写成功但读不回，拒绝判通过）')
    }
    // P5：查询合同探针（失败不推翻基础冒烟，只把 searchQuery 能力降为 off）。
    const queryContract = await probeQueryContract(client, toolTimeout)
    // 清理是尽力而为：残留冒烟节点不改变结论，但失败要留在诊断里。
    const cleanupParts = []
    for (const cleanupId of [nodeId, ...T2_SMOKE_QUERY_NODE_IDS]) {
      try {
        await client.callTool('cg', { op: 'forget', node_id: cleanupId, override: true }, { timeoutMs: toolTimeout })
      } catch (error) {
        cleanupParts.push(cleanupId + ': ' + errorText(error))
      }
    }
    const cleanup = cleanupParts.length === 0 ? 'done' : 'failed: ' + cleanupParts.join('; ')
    const reportedVersion = typeof started.serverInfo?.version === 'string' && started.serverInfo.version.length > 0
      ? started.serverInfo.version
      : version
    return {
      ...base,
      version: reportedVersion,
      tools,
      smokePassed: true,
      smokeNodeId: nodeId,
      smokeCleanup: cleanup,
      queryContract,
      schemaDigest: schemaDigestOf(tools, reportedVersion),
      protocolVersion: started.protocolVersion,
      handle: client,
    }
  } catch (error) {
    const stderr = client === null ? '' : client.stderrOf().slice(-500)
    try { await client?.close?.() } catch { /* 失败路径的关闭不覆盖原始原因 */ }
    return {
      ...base,
      error: errorText(error),
      stderr: stderr.length > 0 ? stderr : undefined,
    }
  }
}
