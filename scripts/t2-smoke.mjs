/**
 * T2 隔离 MCP 真实进程冒烟（0.14.0-beta.35）。
 *
 * 这不是单测：它会真的启动 `python -m md_cg.mcp_server`，在**临时隔离根**里
 * 写一条节点、读回、遗忘，然后关闭。用于验收「隔离根 + recorder 令牌 + MCP
 * 协议 + 写读回」这条链路，不写正式灵枢根。
 *
 * 用法：
 *   node scripts/t2-smoke.mjs
 *   node scripts/t2-smoke.mjs --repo <dsh-memory 包根> --python python
 *   MEMORY_LAB_T2_REPO=<包根> node scripts/t2-smoke.mjs
 *
 * 退出码：0 通过；1 冒烟失败；2 找不到环境（未安装/显式关闭）。
 * 输出只含路径、版本、工具名与结论，不含令牌明文。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveT2Isolated } from '../src/v3/adapters/host/t2-environment.mjs'
import { probeT2Isolated } from '../src/v3/adapters/retrieval/t2-probe.mjs'

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const env = { ...process.env }
  const repoArg = argOf('--repo')
  if (repoArg !== undefined) env.MEMORY_LAB_T2_REPO = repoArg
  const pythonArg = argOf('--python')
  if (pythonArg !== undefined) env.MEMORY_LAB_T2_PYTHON = pythonArg

  const resolved = await resolveT2Isolated({ env })
  if (resolved === null) {
    console.error('[t2-smoke] 找不到 dsh-memory 环境（或 MEMORY_LAB_T2=0）。用 --repo 指定包根。')
    return 2
  }
  const root = await mkdtemp(join(tmpdir(), 'mcl-t2-smoke-'))
  const isolatedRoot = join(root, 't2-mdcg')
  console.log('[t2-smoke] repoRoot=' + resolved.repoRoot)
  console.log('[t2-smoke] python=' + resolved.python + ' version=' + (resolved.version || 'unknown'))
  console.log('[t2-smoke] isolatedRoot=' + isolatedRoot)
  try {
    const described = await probeT2Isolated({
      root: isolatedRoot,
      repoRoot: resolved.repoRoot,
      python: resolved.python,
      version: resolved.version,
      env,
      timeoutMs: 60000,
    })
    const printable = {
      smokePassed: described.smokePassed,
      version: described.version,
      tools: described.tools,
      protocolVersion: described.protocolVersion,
      smokeNodeId: described.smokeNodeId,
      smokeCleanup: described.smokeCleanup,
      error: described.error,
      stderr: described.stderr,
    }
    console.log('[t2-smoke] result=' + JSON.stringify(printable, null, 2))
    if (described.smokePassed !== true) return 1
    const entries = await readdir(isolatedRoot, { withFileTypes: true }).catch(() => [])
    console.log('[t2-smoke] isolatedRoot entries=' + entries.map((entry) => entry.name).join(','))
    await described.handle.close()
    return 0
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('[t2-smoke] 未捕获异常：' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 1
})