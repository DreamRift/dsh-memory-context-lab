// 反向验证夹具（mutation probe）：把每处「已修好的」写法临时还原成修复前的写法，
// 确认对应的回归测试**会失败**。
//
// 为什么需要它：「测试通过」只证明测试没红，不证明测试盯住了这处修复。把修复点
// 反向还原后测试仍然全绿，说明那条回归测试其实没覆盖它。本脚本把这件事变成一条
// 可重跑的命令。
//
// 用法：
//   node scripts/revert-probe.mjs            跑全部场景，输出矩阵
//   node scripts/revert-probe.mjs <caseId>   跑单个场景（打印子进程输出）
//   node scripts/revert-probe.mjs --list     列出场景
//
// 只读本包、只写系统临时目录；不改本仓任何文件。
import { cp, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * 每个场景：目标文件 + [当前写法, 修复前写法] + 应当因此失败的测试文件。
 *
 * `edits` 用「当前源码里的原文」定位，找不到就报夹具脱节（exit 3），
 * 所以源码被大改时这里会明确失败，而不是静默跳过。
 */
const CASES = {
  'abandon-committed': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      `    if (typeof onDisk.committedAt === 'string') {
      // 已提交：句柄释放，但权威事务文件保留。
      this.#openTransactions.delete(handle.txn)
      return { abandoned: false, reason: 'committed' }
    }
`,
      '',
    ]],
  },
  'explicit-txn-overwrite': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      'const occupied = await this.#transactionFileExists(explicitTxn)',
      'const occupied = false',
    ]],
  },
  'disable-barrier': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      `    if (this.disabled) {
      throw new EngineV2Error(\`\${what}被拒绝：v2 会话已停用（停用即只读）。\`, { code: 'EREADONLY' })
    }
`,
      '',
    ]],
  },
  'readonly-writes': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      'if (!this.#readOnly) await this.#persistCatalogSnapshot()',
      'await this.#persistCatalogSnapshot()',
    ]],
  },
  'registry-poison': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      `      openDirectories.delete(directory)
      throw error`,
      '      throw error',
    ]],
  },
  'fork-borrow': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      `    const borrowed = V2SessionStore.peekOpen(labRoot, sessionId)
    if (borrowed) return { store: borrowed, owned: false }
`,
      '',
    ]],
  },
  'fork-synth-copy': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/fork.mjs',
    edits: [[
      "const content = loaded.integrity === 'ok' && typeof loaded.payloadText === 'string' ? loaded.payloadText : null",
      "const content = entry.fidelity === 'verbatim' && loaded.integrity === 'ok' && typeof loaded.payloadText === 'string' ? loaded.payloadText : null",
    ]],
  },
  'v1-takeover-unknown': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/engine.mjs',
    edits: [[
      "  const v2State = await readV2EngineState(labRoot, sessionId)\n  if (v2State.damaged) {\n    // 「无法确认 v2 是否仍持有投影」",
      "  const v2State = await readV2EngineState(labRoot, sessionId)\n  if (false) {\n    // 「无法确认 v2 是否仍持有投影」",
    ]],
  },
  'budget-silent-fallback': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/budget.mjs',
    edits: [[
      `  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      error: \`\${label} 必须是正整数（收到 \${JSON.stringify(raw)}）；0/负数/小数/字符串/NaN 都不接受，请给 1..\${max} 之间的整数，或省略以使用默认 \${fallback}\`,
    }
  }`,
      `  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return { ok: true, value: fallback, source: 'default', clamped: false }
  }`,
    ]],
  },
  'inflight-from-surface': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [[
      '  for (const entry of [...surfaceOpenCalls, ...ledgerOpenCalls]) {',
      '  for (const entry of [...ledgerOpenCalls]) {',
    ]],
  },
  'plain-text-empty-range': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/guard.mjs',
    // 还原点 = P0-2 之前的口径：纯文本范围一律按「空范围」拒（不看 surfaceNodes）。
    // 这里两处一起还原：① `!allowPlainText` 短路整段（v1 口径原样返回）；
    // ② 按 `plainSurfaceNodes` 判空——它**不含助手正文节点**，于是「只有助手
    // 正文的区间」又会被误判成空范围，正是 P0-2 修掉的缺陷。
    edits: [[
      '    if (!allowPlainText) {',
      '    if (true) { // 还原点：P0-2 之前 allowPlainText 不存在，纯文本范围一律走空范围\n    // eslint-disable-next-line no-unreachable',
    ], [
      '    if (scan.surfaceNodes.length === 0) {',
      '    if (scan.plainSurfaceNodes.length === 0) {',
    ], [
      '    if (scan.surfaceNodes.length > 1) {',
      '    if (scan.plainSurfaceNodes.length > 1) {',
    ]],
  },
  'quarantine-txn-reuse': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      '    for (const directory of [quarantineDirectory, this.#legacyQuarantineDirectory()]) {',
      '    for (const directory of []) {',
    ]],
  },
  'concurrent-open': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      '    if (openDirectories.has(directory) || openingDirectories.has(directory)) {',
      '    if (openDirectories.has(directory)) {',
    ]],
  },
  'tool-output-nullable': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/tool.mjs',
    edits: [[
      '    budget_tokens: nullable(\'number\'),',
      '    budget_tokens: { type: \'number\' },',
    ]],
  },
  'payload-kinds-real': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/readback.mjs',
    edits: [[
      '  RECORD_KINDS.PROJECTION_SPAN,',
      "  'projection_span',",
    ]],
  },
  'seq-index': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      '    return [...(this.#seqIndex.get(seq) ?? [])].sort(compareRecordIds)',
      '    return [...this.#catalog.entries()].filter(([, e]) => e.seq === seq).map(([id]) => id).sort(compareRecordIds)',
    ]],
  },
  'literal-index-honesty': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/runtime.mjs',
    edits: [[
      "        } else if (!found.semanticUsed) {",
      "        } else if (false) {",
    ]],
  },
  'readback-payload-text': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/readback.mjs',
    edits: [[
      '            header.text = loaded.payloadText',
      '            header.text = null',
    ]],
  },
  'semantic-used-on-error': {
    test: 'test/v2-retrieval.test.mjs',
    // 真正承重的是「只有查询成功返回才记成用过」这一行：还原它会让一次失败的
    // 语义调用被渲染成 literal+semantic。catch 里的重置是防御性的（成功后才置 true，
    // 之后的 readRetrievalIndex 失败也走同一分支），单独还原它不改变可观测行为。
    file: 'src/v2/retrieval.mjs',
    edits: [[
      '      semanticUsed = true\n      // backend 返回外部 ID 时用记账表换回本会话记录 ID',
      '      // backend 返回外部 ID 时用记账表换回本会话记录 ID',
    ]],
  },
  'byte-as-token': {
    test: 'test/v2-regression.test.mjs',
    file: 'src/v2/budget.mjs',
    edits: [[
      'export function estimateTokensOfBytes(bytes) {',
      'export function estimateTokensOfBytes(bytes) {\n  if (Number.isFinite(bytes)) return Math.max(1, Math.ceil(bytes / 100000)) // 修复前口径：把字节当文本再编码\n  // eslint-disable-next-line no-unreachable',
    ]],
  },
}

/**
 * 跑一个子进程并把它的输出收进文件。
 *
 * 刻意**不用管道**：本机沙箱禁止程序打开命名管道，`stdio: 'pipe'` 的 spawn 会直接
 * `EPERM`。改成把子进程的 stdout/stderr 接到一个临时日志文件的 fd 上——这不是管道，
 * 沙箱允许，而且照样能把输出读回来给报告用。
 */
async function runNode(args, cwd) {
  const logPath = path.join(cwd, `.revert-probe-${Date.now()}.log`)
  const handle = await open(logPath, 'w')
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', handle.fd, handle.fd] })
      child.on('close', (value) => resolve(value))
      child.on('error', () => resolve(null))
    })
    const output = await readFile(logPath, 'utf8').catch(() => '')
    return { code, output }
  } finally {
    await handle.close()
    await rm(logPath, { force: true })
  }
}

async function prepareWorkDir() {
  const work = await mkdtemp(path.join(tmpdir(), 'mcl-revert-probe-'))
  await cp(path.join(PACKAGE_ROOT, 'src'), path.join(work, 'src'), { recursive: true })
  await cp(path.join(PACKAGE_ROOT, 'test'), path.join(work, 'test'), { recursive: true })
  await cp(path.join(PACKAGE_ROOT, 'package.json'), path.join(work, 'package.json'))
  return work
}

async function applyCase(work, caseId) {
  const spec = CASES[caseId]
  const target = path.join(work, spec.file)
  let text = await readFile(target, 'utf8')
  for (const [from, to] of spec.edits) {
    if (!text.includes(from)) {
      throw new Error(`case ${caseId}: 还原点在当前源码里找不到，夹具与源码脱节了`)
    }
    text = text.replace(from, to)
  }
  await writeFile(target, text, 'utf8')
}

const caseId = process.argv[2]

if (caseId === '--list') {
  process.stdout.write(`${Object.keys(CASES).join('\n')}\n`)
  process.exit(0)
}

if (caseId) {
  const spec = CASES[caseId]
  if (!spec) {
    process.stderr.write(`unknown case ${caseId}\n`)
    process.exit(2)
  }
  const work = await prepareWorkDir()
  try {
    await applyCase(work, caseId)
    const result = await runNode([spec.test], work)
    process.stdout.write(result.output)
    process.stdout.write(`\n[revert-probe] ${caseId}: exit=${result.code}\n`)
    process.exit(result.code === 0 ? 1 : 0)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(3)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// 全量：每个场景都必须「还原后测试失败」。
const rows = []
let broken = 0
for (const id of Object.keys(CASES)) {
  const work = await prepareWorkDir()
  try {
    await applyCase(work, id)
    const result = await runNode([CASES[id].test], work)
    const caught = result.code !== 0
    if (!caught) broken += 1
    rows.push({ id, caught, code: result.code })
  } catch (error) {
    broken += 1
    rows.push({ id, caught: false, code: null, note: error.message })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const width = Math.max(...rows.map((row) => row.id.length))
for (const row of rows) {
  const verdict = row.note ? `夹具脱节：${row.note}` : (row.caught ? 'OK（还原后测试失败）' : '未覆盖（还原后测试仍通过）')
  process.stdout.write(`${row.id.padEnd(width)}  ${verdict}\n`)
}
process.stdout.write(`\n场景 ${rows.length} 个，未覆盖 ${broken} 个\n`)
process.exit(broken === 0 ? 0 : 1)
