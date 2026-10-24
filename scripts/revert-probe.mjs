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
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
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
  // 0.11.0：遗忘完整性 P0（去掉候选阶段的可见性检查，回归测试必须变红）
  'member-forgotten': {
    test: 'test/v2-forget-hierarchy.test.mjs',
    file: 'src/v2/hierarchy-coordinator.mjs',
    edits: [[
      `    if (typeof deps.isRecordVisible === 'function' && !deps.isRecordVisible(recordId)) {
      excludedMembers.push({ recordId, seq: seqOfRecordId(receiptTextBySeq, recordId), reason: 'forgotten' })
      continue
    }
`,
      '',
    ]],
  },
  // T2/F-15：成员级排除（去掉子集收窄，被排除者会重新进参与集，回归测试必须变红）
  'member-exclusion': {
    test: 'test/v2-forget-hierarchy.test.mjs',
    file: 'src/v2/hierarchy-coordinator.mjs',
    edits: [['const effectivePlan = withMemberExclusions(plan, { excludedMembers: view.excludedMembers })', 'const effectivePlan = plan']],
  },
  // P0-1：替换节点缺 data.source（把 source 挪回 opts，宿主会静默丢弃，回归测试必须变红）
  'surface-source-in-data': {
    test: 'test/v2-surface-source.test.mjs',
    file: 'src/v2/runtime-compress.mjs',
    edits: [[
      `          source: { kind: PLUGIN_SOURCE_KIND, form: 'memory-lab2-surface' },`,
      '',
    ]],
  },
  // P0-2：prune 名单必须是活动面位置切片（改回 flatMap 拼名单，回归测试必须变红）
  'prune-position-slice': {
    test: 'test/v2-surface-source.test.mjs',
    file: 'src/apply.mjs',
    edits: [['const shadowedSeqs = span.seqs', 'const shadowedSeqs = run.flatMap(({ unit }) => unit.shadowedSeqs)']],
  },
  // P0-3：命令被拒绝时投影不得翻转（删掉权威状态记录的折叠，回归测试必须变红）
  'authoritative-state-fold': {
    test: 'test/v2-surface-source.test.mjs',
    file: 'src/projection.mjs',
    edits: [[
      `  if (event.type === STATE_RECORD_TYPE) {
    const record = stateRecordOf(event, { requireFromPlugin: resolvedFoldContext(context)?.requireFromPlugin })
    if (!record) return state`,
      `  if (event.type === STATE_RECORD_TYPE) {
    const record = null
    if (!record) return state`,
    ]],
  },
  // T1/F-03：卡片默认脱敏（让 disclosedValue 永远返回原值，回归测试必须变红）
  'share-l2-redaction': {
    test: 'test/v2-share-l2-content.test.mjs',
    file: 'src/v2/compressor-program.mjs',
    edits: [[
      `export function disclosedValue(atom, shareContent) {
  if (shareContent === true) return String(atom?.value ?? '')
  return isFreetextAtom(atom) ? WITHHELD_EXCERPT_MARK : String(atom?.value ?? '')
}`,
      `export function disclosedValue(atom, shareContent) {
  return String(atom?.value ?? '')
}`,
    ]],
  },
  // T3/F-09：exact 后验是 AND 不是 OR（改成 some 后纯函数断言必须变红）
  'exact-postfilter-and': {
    test: 'test/v2-weak-pointer.test.mjs',
    file: 'src/v2/retrieval.mjs',
    edits: [['return tokens.every((token) => hay.includes(token.toLowerCase()))', 'return tokens.some((token) => hay.includes(token.toLowerCase()))']],
  },
  // 0.11.0：写锁释放必须校验 token（去掉校验后「不得误删别人的锁」必须变红）
  'write-lock-token': {
    test: 'test/v2-write-lock.test.mjs',
    file: 'src/v2/write-lock.mjs',
    edits: [['if (owner?.token !== entry.token) return false', 'if (false) return false']],
  },
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
      `    openDirectories.delete(this.directory)`,
      '',
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
      "  if (v2State.damaged) {",
      "  if (false) {",
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
    // 域拆分（0.13.1 P4）后这段搬到了 runtime-recall.mjs；夹具跟着源码走。
    file: 'src/v2/runtime-recall.mjs',
    edits: [[
      "          matchedBy: found.semanticUsed ? 'literal+semantic' : 'literal',",
      "          matchedBy: 'literal',",
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
  // 0.13.2-beta.2 W-01：同进程写锁串行化（改回「直接 acquire + run」必红）
  'lock-same-process': {
    test: 'test/v2-write-lock-same-process.test.mjs',
    file: 'src/v2/write-lock.mjs',
    edits: [[
      `  const directory = path.resolve(sessionDir)
  // 已经在同一个临界区里（同一 async 调用链）：直接执行，绝不二次排队。
  if (insideHeldLock(directory)) return run()`,
      `  const directory = path.resolve(sessionDir)
  if (true) {
    const handle = await acquireWriteLock(directory, options)
    try {
      return await run()
    } finally {
      handle.release()
    }
  }`,
    ]],
  },
  // 0.13.2-beta.7 A-1：三份账本的读侧解析已收口到 parseAppendableLedger。
  // 本场景的还原点随之从 hierarchy-store 的本地循环移到共享解析器：
  // 改回「缺 LF 即半行」= 把尾部半行判据放回 parseAppendableLedger 之前，
  // 三份账本会一起复现 D-01（读一次就物理删掉末尾合法条目）。
  'hierarchy-tail-parse': {
    test: 'test/v2-hierarchy-concurrency.test.mjs',
    file: 'src/v2/appendable-ledger.mjs',
    edits: [[
      `      try {
        JSON.parse(tail)
        completeLines.push(tail) // 合法 → 最后一条完整行，不进 partialLine
      } catch {
        partialLine = tail // 只有解析失败的尾巴才是崩溃残留
      }`,
      `      partialLine = tail`,
    ]],
  },
  // 0.13.2-beta.2 W-02：接管失败必须退避（改回静默 return 必红）
  'lock-takeover-backoff': {
    test: 'test/v2-write-lock-takeover.test.mjs',
    file: 'src/v2/write-lock.mjs',
    edits: [[
      `      if (!(await takeOver(lockDir, io))) {
        await retryAfterFailedTakeOver({ lockDir, now, deadline, owner: current })
      }
      continue`,
      `      await takeOver(lockDir, io)
      continue`,
    ]],
  },
  // 0.13.2-beta.2 W-03：崩溃残留清扫（删掉 sweep 调用必红）
  'lock-stage-sweep': {
    test: 'test/v2-lock-stage-sweep.test.mjs',
    file: 'src/v2/write-lock.mjs',
    edits: [[
      '      await sweepLockDebris(lockDir, { beforeMs: acquisitionStartedAt }).catch(() => {})',
      '',
    ]],
  },
  // 0.13.2-beta.2 W-04：尾行计入增量卡预算（改回无条件 push 必红）
  'delta-tail-budget': {
    test: 'test/v2-card-delta-cap.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [[
      `    if (body.length + 3 >= maxLines) { stoppedBy = 'lines'; break }`,
      `    if (body.length + 3 >= maxLines) { stoppedBy = 'lines'; }`,
    ], [
      `    if (next > maxChars - reserved) { stoppedBy = 'chars'; break }`,
      `    if (next > maxChars) { stoppedBy = 'chars'; break }`,
    ]],
  },
  // 0.13.2-beta.2：没做哈希校验不得报 integrity 'ok'
  'integrity-unverified-label': {
    test: 'test/v2-store-integrity-label.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      "    return { integrity: verifyHash ? 'ok' : 'unverified', text, truncated: false, fullBytes, verified }",
      "    return { integrity: 'ok', text, truncated: false, fullBytes, verified }",
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
  // ── 0.13.2-beta.3（第 2 轮真机排查 N-01…N-08）────────────────────────────
  // N-05：清扫判据必须与 mtimeMs 同精度（改回直接比较必红）
  'lock-sweep-clock-precision': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/write-lock.mjs',
    edits: [['    if (!(Math.floor(info.mtimeMs) <= Math.floor(beforeMs))) continue', '    if (!(info.mtimeMs <= beforeMs)) continue']],
  },
  // N-06a：span 候选必须记生产渲染格式 7（改回 5 必红）
  'span-receipt-format': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/history.mjs',
    edits: [['      receiptFormat: RECEIPT_FORMAT_SPAN_V2,', '      receiptFormat: 5,']],
  },
  // N-06b：归档行必须落 spanLabel（不落 → 恢复只能回落成「历史片段」）
  'span-label-row': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/apply-engine.mjs',
    edits: [["          ...(typeof outcome.spanLabel === 'string' && outcome.spanLabel ? { spanLabel: outcome.spanLabel } : {}),\n", '']],
  },
  // N-06c：归档行必须落批次口径（不落 → 批次头只能回落成「N 个相邻操作已合并替换」）
  'batch-fields-row': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/apply-engine.mjs',
    edits: [["          ...(Number.isInteger(outcome.batchThreshold) ? { batchThreshold: outcome.batchThreshold } : {}),\n          ...(Number.isInteger(outcome.batchMembers) ? { batchMembers: outcome.batchMembers } : {}),\n", '']],
  },
  // N-06 迁移：缺标签时按 spanKind 反推（去掉这条候选 → 旧行永远恢复不了）
  'span-label-migration': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/apply.mjs',
    edits: [['      if (spanKind !== null) labels.push(spanLabelOf(spanKind))\n', '']],
  },
  // N-01：同类目只在渲染时合并（改回逐项一段必红）
  'soft-header-merge': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [['${renderSections(mergeSoftSections(sections))}', '${renderSections(sections)}']],
  },
  // N-02：增量卡不得留下「后面没有内容行」的标题（去掉两处裁剪必红）。
  // 诚实边界：N-02 由「不重复补标题」与「裁剪空标题」两层共同保证，单独还原任一层
  // 都会被另一层遮住（不可观测），所以这里按**整条修复**还原。
  'delta-title-dup': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [
      ['  const pruned = pruneEmptyTitles(out)', '  const pruned = out'],
      ['  const finalLines = pruneEmptyTitles(bounded.text.split(\'\\n\'))', "  const finalLines = bounded.text.split('\\n')"],
    ],
  },
  // N-04：全量卡不得自指「见全量卡」（改回旧段头必红）
  'drop-order-selfref': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [["  const softHeader = '■ 软保留（按重要度分值降序装包，低分先丢）'", "  const softHeader = '■ 软保留（按重要度分值降序装包，低分先丢；类目兜底次序见全量卡）'"]],
  },
  // N-07：停用回执必须给出跳过原因（改回「原因见上」必红）
  'restore-skip-reason': {
    test: 'test/v2-beta3-regressions.test.mjs',
    file: 'src/v2/runtime-lifecycle.mjs',
    edits: [['            const why = describeRestoreSkipReasons(outcome?.skippedReasons)', "            const why = '' // 修复前：原因见上"]],
  },
  // ── 0.13.2-beta.4（第 3 轮真机排查 N-09 / N-10 / N-11 + R-03）──────────────
  // N-09：设置值必须以 inner 为底透传（改回白名单构造 → schema 里的
  // protectBudgetTokens / retrievalBackend 在保存时被静默抹掉，必红）
  'settings-whitelist-drift': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/client.js',
    edits: [['      for (var key in base) {\n        if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];\n      }\n', '']],
  },
  // N-10：数字参数必须严格十进制整数（改回 parseInt → 12.7 被截成 12、1e6 被读成 1，必红）
  'set-parseint-truncation': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/core.mjs',
    edits: [['  const text = String(raw).trim()\n  if (!/^\\d+$/.test(text)) return null\n  const value = Number(text)\n  return Number.isSafeInteger(value) ? value : null', "  const value = Number.parseInt(String(raw ?? ''), 10)\n  return Number.isFinite(value) ? value : null"]],
  },
  // N-10 下界：retain 的 0 是合法值（改回写死 1 → 合法值被当错误拒掉，必红）
  'retain-lower-bound': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/v2/runtime-settings.mjs',
    edits: [['      if (value === null || value < NUMERIC_SETTINGS[key].min || value > NUMERIC_SETTINGS[key].max) {', '      if (value === null || value < 1 || value > NUMERIC_SETTINGS[key].max) {']],
  },
  // N-11：format 4 的旧 span 行必须如实 skip（把专属分支关掉 → 落进通用的
  // 「回执正文已变化」，把字段缺失说成用户改了正文，必红）
  'legacy-format4-span': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/apply.mjs',
    edits: [['    if (formatVersion === RECEIPT_FORMAT_VERSION && legacySpanKind !== null && legacySpanKind !== \'operation\') {\n', '    if (false) {\n']],
  },
  // N-11 兜底：单行异常只让该行落 skipped（去掉 try/catch → 一条坏行连坐整批，必红）
  'restore-per-row-guard': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/apply.mjs',
    edits: [['      try {\n        await restoreSingleReceipt({ session, client, receipt, onOutcome, receiptMarker, outcomes })\n      } catch (error) {\n        await reportInternalFailure(receipt, error)\n      }', '      await restoreSingleReceipt({ session, client, receipt, onOutcome, receiptMarker, outcomes })']],
  },
  // R-03：status 行必须印出 autoRestore（删掉 → 「off 会不会恢复原文」只能靠猜，必红）
  'status-auto-restore': {
    test: 'test/v2-beta4-regressions.test.mjs',
    file: 'src/v2/runtime-render.mjs',
    edits: [['      + `restore=${settings.autoRestore ? \'on\' : \'off\'} `\n', '']],
  },
  // ── 0.13.2-beta.5（第 4 轮真机排查 Q-01 / P-01 / M-01 / N-12 / O-01）──────────
  // Q-01：autoRestore 必须决定「要不要恢复」（把判断还原成只影响守卫 → off 照样
  // 全量恢复，必红）
  'autorestore-switch-noop': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/v2/runtime-lifecycle.mjs',
    edits: [['      if (!autoRestore) {', '      if (false) {']],
  },
  // Q-01b：窗口守卫不得受开关影响（把守卫并回 autoRestore 条件 → 关掉开关时守卫
  // 一起消失，必红）
  'autorestore-guard-always': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/v2/runtime-lifecycle.mjs',
    edits: [['      if (pendingCount > 0) {', '      if (pendingCount > 0 && autoRestore) {']],
  },
  // P-01：没有库时必须交 null（删掉 listRecordsPage 的 null 分支 → finally 里
  // store.close() 抛 TypeError，必红）
  'readback-null-store': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/v2/readback.mjs',
    edits: [['  if (!store) return null\n  try {\n    // 遗忘记录不进列表', '  try {\n    // 遗忘记录不进列表']],
  },
  // P-01b：精确回读必须抛业务错误（删掉 ENOSTORE 分支 → 内部 TypeError 盖住
  // 「没有库」，必红）
  'readback-nostore-error': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/v2/readback.mjs',
    edits: [['  if (!store) {\n    throw new EngineV2Error(', '  if (false) {\n    throw new EngineV2Error(']],
  },
  // M-01：设置页数字框必须与命令面同一把尺子（改回 Math.round(Number(text)) →
  // 清空变下界、2.5 变 3、0x10 变 16，必红）
  'numberinput-silent-coerce': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/client.js',
    edits: [['        var n = parseCount(text);\n        if (n === null) {', '        var n = Math.round(Number(text));\n        if (!isFinite(n)) {']],
  },
  // M-01b：parseCount 本身也必须是严格十进制（改回 Number() → 0x10/2e1/空串
  // 全部 isFinite，必红）
  'parse-count-strict': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/client.js',
    edits: [["      if (!/^\\d+$/.test(raw)) return null;\n", '']],
  },
  // N-12：schema 的数字域必须从 NUMERIC_SETTINGS 派生（改回 natural().max(200) →
  // 归档批量 0 在 schema 里合法、在别处被换值，必红）
  'batch-schema-domain': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/index.mjs',
    edits: [[
      '      archiveBatchSize: SCHEMAS.natural()\n        .min(NUMERIC_SETTINGS.batch.min).max(NUMERIC_SETTINGS.batch.max)',
      '      archiveBatchSize: SCHEMAS.natural().min(0).max(NUMERIC_SETTINGS.batch.max)',
    ]],
  },
  // O-01：每页条数不得静默夹到上限（把 resolvePageSize 的上界判断删掉 → 999999
  // 变成 2000，必红）
  'history-pagesize-clamp': {
    test: 'test/v2-beta5-regressions.test.mjs',
    file: 'src/v2/readback.mjs',
    edits: [['  if (parsed > MAX_PAGE_SIZE) {', '  if (false) {']],
  },
  // ── beta.6 根因组（G1…G9）：每条对应一个根因抽象，改回症状修法必红 ──
  // G1/G4：beta.7 把 g1/g4 两份测试合并成 v2-beta6-g1-ledger-g4-state.test.mjs，
  // 这里跟着重指（夹具对准源码现状）。G4 是结构性覆盖（还原点让 REQUIRED_STATE_FIELDS
  // 失去导出，测试 import 即崩）；G1 若合并测试没有空白账本用例，会如实记「未覆盖」。
  // G1：三份 append-only 账本共用一个开账协议。改回「各自 if (size===0) 补 header」
  // 就是 P0 原形（0 字节账本无 header + 尾部修复不在写锁内）。
  'appendable-ledger-shared': {
    test: 'test/v2-beta6-g1-ledger-g4-state.test.mjs',
    file: 'src/v2/appendable-ledger.mjs',
    edits: [[
      "    if (text === null || text.trim().length === 0) {",
      '    if (text === null || text.length === 0) {',
    ]],
  },
  // G2：对外错误统一基类。把 InvalidArgumentError 退回裸 TypeError，
  // 任何调用方拿到的 code 又变回 undefined。
  'error-contract-code': {
    test: 'test/v2-beta6-g2-error-contract.test.mjs',
    file: 'src/errors.mjs',
    edits: [[
      'export class InvalidArgumentError extends EngineV2Error {',
      'class InvalidArgumentError extends TypeError {',
    ]],
  },
  // G3：未知量三态。restoreGrowth 把「窗口未知」判成 overflow:false 就是失败开放。
  'restore-growth-unknown': {
    test: 'test/v2-beta6-g3-three-state.test.mjs',
    file: 'src/core.mjs',
    edits: [[
      '  if (!assembledKnown || !windowKnown) {',
      '  if (false) {',
    ]],
  },
  // G4：状态字段清单单一真源。闸门只校验 4 个字段 → 消费方裸取 archive 抛 TypeError。
  'state-required-fields': {
    test: 'test/v2-beta6-g1-ledger-g4-state.test.mjs',
    file: 'src/v2/state.mjs',
    edits: [[
      'export const REQUIRED_STATE_FIELDS = Object.freeze([',
      'const REQUIRED_STATE_FIELDS = Object.freeze([',
    ]],
  },
  // G5：命令结果宿主契约。错误结果不带 text，宿主侧直接 TypeError。
  'host-result-contract': {
    test: 'test/v2-beta6-g5-command-result.test.mjs',
    file: 'src/v2/command-result.mjs',
    edits: [[
      "  if (!result || typeof result !== 'object' || result.kind !== 'error') return result",
      '  return result',
    ]],
  },
  // G6：导出即被使用。rememberRecall 定义但无调用 → 回注去重整条链失效。
  'dead-export-recall': {
    test: 'test/v2-beta6-g6-dead-export.test.mjs',
    file: 'src/v2/runtime-recall.mjs',
    edits: [[
      '    engine.rememberRecall(record, {',
      '    void 0 && engine.rememberRecall(record, {',
    ]],
  },
  // G7：注释即规格。piggyback 说「够批就进 units」而实现 continue 跳过。
  'comment-is-spec-piggyback': {
    test: 'test/v2-beta6-g7-comment-spec.test.mjs',
    file: 'src/apply.mjs',
    edits: [[
      '  if (countable.length >= threshold) {',
      '  if (false) {',
    ]],
  },
  // G8：读账本并发登记走同一把锁 + 原子替换。
  'read-ledger-concurrent': {
    test: 'test/v2-beta6-g8-read-ledger.test.mjs',
    file: 'src/v2/read-ledger.mjs',
    edits: [[
      '  return withWriteLock(sessionDir, () => registerReadsUnlocked(sessionDir, {',
      '  return (async (fn) => fn())(async () => registerReadsUnlocked(sessionDir, {',
    ]],
  },
  // G9：句柄关闭后不得再开事务（否则同进程两把写锁）。
  'store-closed-guard': {
    test: 'test/v2-beta6-g9-store-closed.test.mjs',
    file: 'src/v2/store.mjs',
    edits: [[
      '    if (this.#closed) {',
      '    if (false) {',
    ]],
  },
  // ── beta.8（Q3/Q4）：卡片治理与未接线类目 ──
  // Q3-A 一进一出：把「槽位存在才替换」还原成「永不替换」（恒 append）——
  // 双槽不变量消失，卡节点数随步数无界增长，v2-card-replace 的 R1 必红。
  'card-replace-target': {
    test: 'test/v2-card-replace.test.mjs',
    file: 'src/v2/runtime-card.mjs',
    edits: [[
      '      if (form === \'delta\') {\n        const deltaSlots = live(findCardSlotsOf(session, { full: false }))\n        if (deltaSlots.length > 0) {',
      '      if (form === \'delta\') {\n        const deltaSlots = live(findCardSlotsOf(session, { full: false }))\n        if (false) {',
    ], [
      '      } else {\n        const fullSlots = live(findCardSlotsOf(session, { full: true }))\n        if (fullSlots.length > 0) {',
      '      } else {\n        const fullSlots = live(findCardSlotsOf(session, { full: true }))\n        if (false) {',
    ]],
  },
  // Q3-A 失败降级：把「宿主拒绝 → ok:false」还原成「拒绝也报 ok」——卡静默丢失、
  // fallback 不计数（fail-visible 消失），R4 必红。
  'card-replace-fallback': {
    test: 'test/v2-card-replace.test.mjs',
    file: 'src/v2/runtime-card.mjs',
    edits: [[
      '    } catch {\n      return { ok: false }\n    }\n  }',
      '    } catch {\n      return { ok: true, anchorSeq: null, receiptOk: true }\n    }\n  }',
    ]],
  },
  // Q3-A 增量基准：把「基准 = 上一张全量卡渲染文本」还原成「基准 = 上一张注入文本」
  // ——增量卡会重复宣告上一张增量卡已宣告的行，R5 必红。
  'delta-baseline': {
    test: 'test/v2-card-replace.test.mjs',
    file: 'src/v2/runtime-card.mjs',
    edits: [[
      '      text: prepared.cardText,',
      '      text: prepared.text,',
    ]],
  },
  // Y-31 硬/软去重：把「call-only/未曝光行不进软段」还原成「每个调用都进进度行」
  // ——同一事实双渲染回归，v2-workingset 的 Y-31 用例必红。
  'soft-dup': {
    test: 'test/v2-workingset.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [[
      '    if (!result) continue\n    if (exposureDecidable && result.seq > threshold) continue\n',
      '',
    ]],
  },
  // Y-32 可执行句柄：把「readable 才印句柄」还原成「有 ref 就印」——seq:N 死句柄
  // 回归（模型照抄必败），v2-workingset 的 Y-32 用例必红。
  'readable-handle': {
    test: 'test/v2-workingset.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [[
      "    if (ref && ref.readable === true && typeof ref.ref === 'string' && ref.ref !== '') {",
      "    if (ref && typeof ref.ref === 'string' && ref.ref !== '') {",
    ]],
  },
  // Q4 死入参回流：把零生产方形参 constraints 偷偷加回签名——wiring 守卫①
  // （形参必须接线或白名单）必红，「先渲染后接线」的死类目不再可能静默回归。
  'dead-input-regression': {
    test: 'test/v2-workingset-wiring.test.mjs',
    file: 'src/v2/working-state.mjs',
    edits: [[
      '  recordIdsForSeq = null,',
      '  constraints = [],\n  recordIdsForSeq = null,',
    ]],
  },
  // ── beta.9 P0-3：回执生命周期接线 ──
  // 还原「批次提交后收敛 + slim 置位」——明细回执不再合并、slim 不再生效，
  // v2-receipt-lifecycle 的 R7 接线判据必红（回执无界累积回归）。
  'receipt-lifecycle': {
    test: 'test/v2-receipt-lifecycle.test.mjs',
    file: 'src/v2/runtime.mjs',
    edits: [[
      "    receiptSlimOf: (record) => slimStyleOf(record?.state) === 'slim',",
      "    receiptSlimOf: null, // revert-probe：还原 slim 判定",
    ], [
      "    afterBatchCommitted: (record, session) => {\n      const report = consolidateReceipts(session, { pluginSourceKind: PLUGIN_SOURCE_KIND })\n      if (report.fallbacks > 0) record.cost.bump('receiptMergeFallbacks', report.fallbacks)\n      record.state.receiptSamplePrinted = true\n    },",
      "    afterBatchCommitted: null, // revert-probe：还原收敛回调",
    ]],
  },
  // ── beta.9 P0-1：遗忘传播接线 ──
  // P0-1：把「受影响派生记录并入同一条 forget 条目」还原成「只写显式目标」——
  // forget(A) 后 B/B' 重新可被检索命中，v2-forget-propagation 的验收判据必红。
  'forget-propagation': {
    test: 'test/v2-forget-propagation.test.mjs',
    file: 'src/v2/disposition.mjs',
    edits: [[
      '  const propagatedIds = (propagation?.recordIds ?? []).filter((id) => !visibility.has(id))',
      '  const propagatedIds = []',
    ]],
  },
  // P0-2：把 displayPreview 的推理段过滤还原成裸展平——预览重新泄漏 [推理]
  // 段正文，v2-reasoning-preview 的三处预览判据必红。
  'reasoning-not-in-preview': {
    test: 'test/v2-reasoning-preview.test.mjs',
    file: 'src/core.mjs',
    edits: [[
      "  const text = skipReasonSection(value).replace(/\\s+/g, ' ').trim()",
      "  const text = String(value ?? '').replace(/\\s+/g, ' ').trim()",
    ]],
  },  // P0-5：契约接线守卫的坏样本（M14）——注入死导出 / 未定义引用，
  // contract-wiring 的两道闸必须分别变红。
  'contract-wiring-dead-export': {
    test: 'test/contract-wiring.test.mjs',
    file: 'src/core.mjs',
    edits: [[
      'export const MIN_OPERATION_CHARS = 1200',
      'export const MIN_OPERATION_CHARS = 1200\nexport const __probeDeadExportP05 = 1',
    ]],
  },
  'contract-wiring-undefined-ref': {
    test: 'test/contract-wiring.test.mjs',
    file: 'src/core.mjs',
    edits: [[
      'export const MIN_OPERATION_CHARS = 1200',
      'export const MIN_OPERATION_CHARS = 1200\nfunction __probeUndefinedRefP05() { return __probeMissingIdP05 + 1 }',
    ]],
  },  // P0-4：把 preview 级联预告的传递闭包还原成空集——forget preview 不再报告
  // 派生级联，v2-forget-propagation 的 preview 判据必红。
  'forget-preview-cascade': {
    test: 'test/v2-forget-propagation.test.mjs',
    file: 'src/v2/disposition.mjs',
    edits: [[
      '      const dependents = report.affected.filter((id) => !visibility.has(id))',
      '      const dependents = [].filter((id) => !visibility.has(id))',
    ]],
  },  // P0-4：把 model-ledger 三钩子的生产接线还原成直通——缓存/费用侧车重新
  // 无人供给，v2-compressor-model 的接线判据必红。
  'model-ledger-wiring': {
    test: 'test/v2-compressor-model.test.mjs',
    file: 'src/v2/runtime-compress.mjs',
    edits: [[
      '          const wireModelLedger = true',
      '          const wireModelLedger = false',
    ]],
  },  // P0-2 补充（核验小项②）：把续块的失败关闭判定还原成单参调用——续块预览
  // 重新泄漏 [推理] 段尾（无段头可滤），v2-reasoning-chunk-boundary 必红。
  'reasoning-chunk-boundary': {
    test: 'test/v2-reasoning-chunk-boundary.test.mjs',
    file: 'src/v2/client-adapter.mjs',
    edits: [[
      "            if (body !== null) previewById.set(entry.id, recallPreviewOf(skipReasonSection(body, { continuation: isChunkContinuation })))",
      "            if (body !== null) previewById.set(entry.id, recallPreviewOf(skipReasonSection(body)))",
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
async function runNode(args, cwd, { timeoutMs = 60_000 } = {}) {
  const logPath = path.join(cwd, `.revert-probe-${Date.now()}.log`)
  const handle = await open(logPath, 'w')
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', handle.fd, handle.fd] })
      // 超时按「测试失败」计：反向验证只要求还原后**不能全绿**；性能型用例
      // 在还原后会退化成 O(n) 长跑，没有上限会把整条探针拖成小时级。
      const timer = setTimeout(() => {
        // 杀掉整棵进程树：node --test 默认把测试文件放进子进程，父进程被杀后
        // 子进程仍持有日志 fd，'close' 永远等不到。Windows 用 taskkill /T。
        try {
          if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            child.kill('SIGKILL')
          }
        } catch { /* 已退出 */ }
      }, timeoutMs)
      child.on('close', (value) => { clearTimeout(timer); resolve(value) })
      child.on('error', () => { clearTimeout(timer); resolve(null) })
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
  // 夹具里的还原点用 LF 书写；本仓在 Windows 检出可能是 CRLF，先归一化再匹配，
  // 否则多行还原点会全部「找不到」而误报夹具脱节。临时副本不参与版本库，改行尾无副作用。
  let text = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n')
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
    if (!existsSync(path.join(PACKAGE_ROOT, spec.test))) {
      process.stderr.write(`case ${caseId}: 测试文件不存在：${spec.test}（记未覆盖）\n`)
      process.exit(4)
    }
    await applyCase(work, caseId)
    // 与 package.json 的测试链同口径：无 force-exit 时部分套件会因常驻句柄
    // 挂住，探针永远等不到 close（把「测试失败」误读成「夹具卡死」）。
    const result = await runNode(['--test-force-exit', spec.test], work)
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
    // 测试文件不存在时 node 也会以非 0 退出，曾被当成「还原后测试失败」记 OK——
    // 那是把「没有断言可跑」伪装成守卫成立（0.13.2-beta.8 修正：8 个 beta.6 场景
    // 指向已合并/已删除的测试文件，全部虚计 OK）。缺失一律如实记「未覆盖」。
    if (!existsSync(path.join(PACKAGE_ROOT, CASES[id].test))) {
      broken += 1
      rows.push({ id, caught: false, code: null, note: `测试文件不存在：${CASES[id].test}（记未覆盖，不计 OK）` })
      continue
    }
    await applyCase(work, id)
    const result = await runNode(['--test-force-exit', CASES[id].test], work)
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
let okCount = 0
for (const row of rows) {
  if (row.caught) okCount += 1
  const verdict = row.note
    ? (row.note.startsWith('测试文件不存在') ? row.note : `夹具脱节：${row.note}`)
    : (row.caught ? 'OK（还原后测试失败）' : '未覆盖（还原后测试仍通过）')
  process.stdout.write(`${row.id.padEnd(width)}  ${verdict}\n`)
}
process.stdout.write(`\n场景 ${rows.length} 个，OK ${okCount} 个，未覆盖 ${broken} 个\n`)
process.exit(broken === 0 ? 0 : 1)
