/**
 * P2-b 生产接线守卫（0.15.0）：pre-step 局部快照 → assistant/message 配对 → 账本。
 *
 * ## 判据来源
 * - P0 宿主合同 §2.1：agent/pre-step 交出 {messages: claimed, turn, step, signal}；
 *   system prompt / 工具 schema 的组装在随后 step() 内部 ⇒ 插件只能观测 plugin-surface 的消息前缀。
 * - P0 §2.9：assistant/message 载荷自带 turn/step/usage（请求/步骤配对**不需要插件快照**）；
 *   usage 与 step 的关联凭宿主字段即可，插件只把同一步的 pre-step 快照按 turn:step 配上去。
 * - 开发流程 §3.4：宿主压缩/恢复/外部改面使 epoch 失效；§3.5：未知用 null。
 * - 主代理口径：观测只用于关联/审计，不参与归档/P3 策略选择（W9 静态守卫锁死）。
 *
 * ## 断言组
 * W1 配对成功与字段形状 / W2 追加 / W3 改写推进 epoch / W4 配不上保持 null /
 * W5 跨进程种子（重启后 epoch 连续）/ W6 落盘失败不推进前值 /
 * W7 快照失败不影响摄入 / W8 重放幂等 / W9 观测不进入决策面（导入级 + 符号级，
 * 含定点变异自证）/ W10 跳过行（seq 回退 + 有快照）不推进内存代际。
 *
 * ## 不适用条件与已知边界
 * - 用合成宿主事件驱动真实 engine 摄入与账本落盘；真实 DSH 运行时时序、llm/stream、wire 仍未验。
 * - W9 只做**静态**判据：解析 src/v3 的静态 import/export-from 与 entry 内的标识符归属；
 *   不解析动态 import()/createRequire，也不解析模板字面量插值里的表达式
 *   （本仓不使用把观测值经模板拼进归档参数的形态；引入时须扩守卫）。
 * - W9 绿 ≠ 全仓清净：它只锁「观测模块的导入者」与「entry 里观测符号所在函数」两个面，
 *   不证明运行期数据流（例如通过全局 Map 间接传递）不存在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { appendCacheObservation } from '../src/v3/adapters/storage/usage-log.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 真实宿主形状：{id, log, deriveMessages(), header}；messages 只是投影（不含正文要求）。 */
function fakeSession(id, messages = []) {
  return {
    id,
    log: [],
    messages: [...messages],
    header: { cwd: null },
    // 与 P2-a 接线测试同源：宿主适配器要求含 append 的 session 对象
    surface: { nodes: [] },
    append() { return { seq: 0 } },
    eventAt() { return null },
    deriveMessages() { return [...this.messages] },
    push(type, data, extra = {}) {
      const event = { seq: this.log.length, type, time: 1700000000000 + this.log.length * 10, data, ...extra }
      this.log.push(event)
      return event
    },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const warns = []
  const ctx = {
    on(n, h) { handlers.set(n, h); return () => {} },
    logger: { warn(m) { warns.push(String(m)) }, info() {} },
  }
  ctx.callPreStep = async (agent, position = {}) => await handlers.get('agent/pre-step')(
    { agent, signal: position.signal, turn: position.turn, step: position.step },
    async () => ({ kind: 'enter' }),
  )
  ctx.warns = warns
  return ctx
}

async function withEngine(body, root) {
  const dir = root ?? await mkdtemp(path.join(tmpdir(), 'mcl-p2b-wiring-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: dir })
  try {
    return await body({ dir, ctx, engine })
  } finally {
    engine.dispose()
    if (root === undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const observationFile = (root, sid) => path.join(root, 'sessions', sid, 'cache-observations.jsonl')

async function readRows(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function exists(file) {
  try { await stat(file); return true } catch { return false }
}

// ---------------------------------------------------------------- W9 静态扫描器
//
// 判据不是「某个字符串出现过」，而是**导入关系**与**entry 内符号归属**：
// - 观测模块（合同 / 账本适配器 / 入口）只允许被这三个文件自身导入；
//   决策层（application/domain）更不得导入它们（含反向导入 entry）。
// - entry 里观测符号（账本 API 与 `cacheProjection` 前值）只允许出现在
//   ensureEntry / appendObservation / capturePreStepSurface 三个接线函数里；
//   出现在 archiveForStep / runArchiveForStep 等决策函数里即违规。

const V3_SRC = path.join(SRC, 'v3')
const OBSERVATION_MODULE_PATHS = new Set([
  'contracts/cache-observation.mjs',
  'adapters/storage/usage-log.mjs',
  'entry/v3-entry.mjs',
])
const ALLOWED_OBSERVATION_IMPORTER_PATHS = new Set(OBSERVATION_MODULE_PATHS)
const OBSERVATION_SYMBOL_RULES = {
  appendCacheObservation: ['appendObservation'],
  readCacheProjectionState: ['ensureEntry'],
  messageDigestOf: ['capturePreStepSurface'],
  normalizeUsageObservation: ['appendObservation'],
  cacheProjection: ['ensureEntry', 'appendObservation'],
}

const slashPath = (value) => value.replaceAll('\\', '/')

async function mjsFilesOf(root) {
  const out = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs')) out.push(full)
    }
  }
  await walk(root)
  return out
}

/** 把注释/字符串/模板内容抹成空格（保留换行与偏移），让标识符与括号扫描只看代码。 */
function maskNonCode(source) {
  const out = source.split('')
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      out[index] = ' '
      out[index + 1] = ' '
      index += 2
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index += 1 }
      continue
    }
    if (char === '/' && next === '*') {
      out[index] = ' '
      out[index + 1] = ' '
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' '
        index += 1
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2 }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out[index] = ' '
      index += 1
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          out[index] = ' '
          if (index + 1 < source.length) out[index + 1] = ' '
          index += 2
          continue
        }
        if (inner === quote) { out[index] = ' '; index += 1; break }
        if (inner === '\n' && quote !== '`') { index += 1; break }
        if (inner !== '\n') out[index] = ' '
        index += 1
      }
      continue
    }
    index += 1
  }
  return out.join('')
}

/** 静态 import / export-from 的 specifier（在原文上提取：specifier 本身是字符串，会被 mask 掉）。 */
function importSpecifiersOf(source) {
  const specs = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\w$\{\},\s*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:\*)?(?:[\w$\{\},\s*]+)?\s+from\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1])
  }
  return specs
}

/** 具名函数（含 async / export）的声明区间；用于判断某个标识符属于哪个函数。 */
function functionRangesOf(masked) {
  const ranges = []
  const pattern = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g
  for (const match of masked.matchAll(pattern)) {
    const name = match[1]
    const declStart = match.index + (match[0].startsWith('\n') ? 1 : 0)
    let index = match.index + match[0].length
    let parens = 1
    while (index < masked.length) {
      if (masked[index] === '(') parens += 1
      else if (masked[index] === ')') {
        parens -= 1
        index += 1
        if (parens === 0) break
        continue
      }
      index += 1
    }
    while (index < masked.length && masked[index] !== '{') index += 1
    if (index >= masked.length) continue
    let depth = 0
    for (; index < masked.length; index += 1) {
      if (masked[index] === '{') depth += 1
      else if (masked[index] === '}') {
        depth -= 1
        if (depth === 0) { index += 1; break }
      }
    }
    ranges.push({ name, start: declStart, end: index })
  }
  return ranges
}

function enclosingFunctionOf(ranges, index) {
  let best = null
  for (const range of ranges) {
    if (index >= range.start && index <= range.end && (best === null || range.end - range.start < best.end - best.start)) best = range
  }
  return best?.name ?? null
}

const lineNumberAt = (source, index) => source.slice(0, index).split('\n').length

/** 导入面：观测模块的导入者白名单 + 决策层禁入。 */
async function observationImportScan(root) {
  const files = await mjsFilesOf(root)
  const violations = []
  const importers = new Set()
  let relativeImports = 0
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const rel = slashPath(path.relative(root, file))
    const layer = rel.split('/')[0]
    for (const spec of importSpecifiersOf(source)) {
      if (!spec.startsWith('.')) continue
      relativeImports += 1
      const target = slashPath(path.relative(root, path.resolve(path.dirname(file), spec)))
      if (!OBSERVATION_MODULE_PATHS.has(target)) continue
      importers.add(rel)
      if (!ALLOWED_OBSERVATION_IMPORTER_PATHS.has(rel)) {
        violations.push({ file: rel, spec, target, reason: '观测模块只允许合同自身 / 账本适配器 / 入口接线导入' })
      }
      if ((layer === 'application' || layer === 'domain') && target !== rel) {
        violations.push({ file: rel, spec, target, reason: '决策层（application/domain）不得导入观测合同/账本/入口' })
      }
    }
  }
  return { files: files.length, relativeImports, importers: [...importers].sort(), violations }
}

/** 符号面：entry 里观测符号只允许出现在指定接线函数内。 */
function entryObservationSymbolAudit(source) {
  const masked = maskNonCode(source)
  const ranges = functionRangesOf(masked)
  const violations = []
  const counts = {}
  for (const [name, allowed] of Object.entries(OBSERVATION_SYMBOL_RULES)) {
    const pattern = new RegExp('\\b' + name + '\\b', 'g')
    let count = 0
    for (const match of masked.matchAll(pattern)) {
      count += 1
      const enclosing = enclosingFunctionOf(ranges, match.index)
      if (enclosing === null) {
        const lineStart = masked.lastIndexOf('\n', match.index) + 1
        if (/^\s*import\b/.test(source.slice(lineStart, match.index))) continue
        violations.push({ name, function: null, line: lineNumberAt(masked, match.index), reason: '模块顶层使用观测符号' })
        continue
      }
      if (!allowed.includes(enclosing)) {
        violations.push({ name, function: enclosing, line: lineNumberAt(masked, match.index), reason: '观测符号出现在决策函数里' })
      }
    }
    counts[name] = count
  }
  return { violations, counts, ranges }
}

const fileSha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantMsg = (text, provider = 'deepseek', model = 'deepseek-v4.1-flash') => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider, model },
})

/**
 * 建库预热：真实宿主第一步的 pre-step 也发生在 entry 建好之前（后台建库），
 * 该步没有快照 ⇒ 第一步 surface=null 是**设计边界**，不是配对缺陷。
 * 测试要验配对，先让 entry 就绪（不带 turn/step 的空 pre-step 不产生快照）。
 */
async function warmUp({ ctx, engine, session }) {
  await ctx.callPreStep({ session }, {})
  await engine._waitForIdle()
}

/** 一步：先留 pre-step 快照，再让本步的 assistant 事件进入下一轮摄入。 */
async function preStep({ ctx, engine, session, turn, step, messages }) {
  if (messages !== undefined) session.messages = [...messages]
  await ctx.callPreStep({ session }, { turn, step })
  await engine._waitForIdle()
}

function pushAssistant(session, { turn, step, usage, text = '答', provider, model }) {
  return session.push('assistant/message', {
    turn,
    step,
    message: assistantMsg(text, provider, model),
    usage,
  })
}

// ---------------------------------------------------------------- W1 配对

test('W1 配对成功：request 取宿主 turn/step/provider/model；surface 是 pre-step 局部面', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const secret = '绝不应该出现在账本里的正文'
    const session = fakeSession('s-pair')
    await warmUp({ ctx, engine, session })
    const m0 = [userMsg('系统提示占位'), userMsg(secret)]
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: m0 })
    const event = pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 300, outputTokens: 10 } })
    session.messages = [...m0, assistantMsg('答')]
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: session.messages })

    const rows = await readRows(observationFile(dir, 's-pair'))
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.contractVersion, 4)
    assert.deepEqual(row.request, { turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    assert.equal(row.surface.snapshot, 'pre-step')
    assert.equal(row.surface.phase, 'initial')
    assert.equal(row.surface.epoch, 0)
    assert.equal(row.surface.messageChange, null, '首次观测没有前值')
    assert.deepEqual(row.surface.coverage, { system: 'unobservable', tools: 'unobservable', messages: 'observed' })
    assert.equal(row.surface.messageChain.length, 2)
    assert.equal(JSON.stringify(row).includes(secret), false, '账本不得含正文')
    assert.equal(row.seq, event.seq, 'seq 仍是宿主 assistant 事件（幂等键）')
  })
})

// ---------------------------------------------------------------- W2 追加

test('W2 同一前缀 + 新消息 = append：epoch 不推进，指纹变化', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-append')
    await warmUp({ ctx, engine, session })
    const base = [userMsg('问')]
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: base })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } })
    const afterFirst = [...base, assistantMsg('答')]
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: afterFirst })
    pushAssistant(session, { turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 2 } })
    const afterSecond = [...afterFirst, userMsg('新一句')]
    await preStep({ ctx, engine, session, turn: 1, step: 3, messages: afterSecond })

    const rows = await readRows(observationFile(dir, 's-append'))
    assert.equal(rows.length, 2)
    assert.notEqual(rows[1].surface.fingerprint, rows[0].surface.fingerprint)
    assert.equal(rows[1].surface.messageChange, 'appended')
    assert.equal(rows[1].surface.phase, 'append')
    assert.equal(rows[1].surface.epoch, 0, '内容增长不是缓存失效')
    assert.equal(rows[1].request.step, 2)
  })
})

// ---------------------------------------------------------------- W3 改写

test('W3 同位置改写 = epoch-start：只报投影前缀变化，epoch 前移', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-rewrite')
    await warmUp({ ctx, engine, session })
    const base = [userMsg('原始问句'), userMsg('背景')]
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: base })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } })
    const afterFirst = [...base, assistantMsg('答')]
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: afterFirst })
    pushAssistant(session, { turn: 1, step: 2, usage: { inputTokens: 10, outputTokens: 1 } })
    // 宿主压缩/恢复把第 1 条换成回执：同位置内容变化
    const compacted = [userMsg('归档回执替代原文'), userMsg('背景')]
    await preStep({ ctx, engine, session, turn: 1, step: 3, messages: compacted })
    pushAssistant(session, { turn: 1, step: 3, usage: { inputTokens: 10, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 1, step: 4, messages: [...compacted, assistantMsg('答')] })

    const rows = await readRows(observationFile(dir, 's-rewrite'))
    assert.equal(rows.length, 3, '第 1 步、第 2 步追加、第 3 步改写各一条')
    assert.equal(rows[1].surface.phase, 'append')
    const rewrite = rows[2]
    assert.equal(rewrite.surface.messageChange, 'message-prefix-rewritten')
    assert.equal(rewrite.surface.phase, 'epoch-start')
    assert.equal(rewrite.surface.reason, 'message-prefix-rewritten')
    assert.equal(rewrite.surface.firstDivergence, 0)
    assert.equal(rewrite.surface.epoch, 1)
    assert.equal('cacheInvalidated' in rewrite.surface, false)
  })
})

// ---------------------------------------------------------------- W4 配不上

test('W4 配对不上：没有 turn/step 或没有同一步快照 → surface 保持 null（request 有宿主字段才写）', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-nopair')
    await warmUp({ ctx, engine, session })
    session.push('user/message', { text: '问' })
    // 没有快照：只推 assistant，pre-step 位置给别的步
    pushAssistant(session, { turn: 2, step: 1, usage: { inputTokens: 5, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 9, step: 9, messages: [userMsg('别的步')] })
    // 另一个事件：宿主没给 turn/step
    session.push('assistant/message', { message: assistantMsg('答'), usage: { inputTokens: 6, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 9, step: 10, messages: [userMsg('别的步')] })

    const rows = await readRows(observationFile(dir, 's-nopair'))
    assert.equal(rows.length, 2)
    const pairedMiss = rows.find((row) => row.request !== null)
    assert.deepEqual(pairedMiss.request, { turn: 2, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    assert.equal(pairedMiss.surface, null, '没有同一步快照 → 投影未知，不拿别步顶替')
    const noPosition = rows.find((row) => row.request === null)
    assert.ok(noPosition, '宿主没给 turn/step 时 request 必须是 null')
    assert.equal(noPosition.surface, null)
  })
})

// ---------------------------------------------------------------- W5 跨进程

test('W5 跨进程种子：重启后 epoch 连续；改写可判、firstDivergence 记 null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p2b-restart-'))
  try {
    const messages = [userMsg('问一')]
    const session = fakeSession('s-restart', messages)
    await withEngine(async ({ ctx, engine }) => {
      await warmUp({ ctx, engine, session })
      await preStep({ ctx, engine, session, turn: 1, step: 1, messages })
      pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } })
      await preStep({ ctx, engine, session, turn: 1, step: 2, messages: [...messages, assistantMsg('答一')] })
    }, root)
    const first = await readRows(observationFile(root, 's-restart'))
    assert.equal(first.length, 1)
    assert.equal(first[0].surface.epoch, 0)

    // 新进程：同一会话目录、同一事件日志（断点续传），surface 变成追加
    await withEngine(async ({ ctx, engine }) => {
      await warmUp({ ctx, engine, session })
      const appended = [...messages, assistantMsg('答一'), userMsg('问二')]
      await preStep({ ctx, engine, session, turn: 1, step: 2, messages: appended })
      pushAssistant(session, { turn: 1, step: 2, usage: { inputTokens: 11, outputTokens: 1 } })
      await preStep({ ctx, engine, session, turn: 1, step: 3, messages: [...appended, assistantMsg('答二')] })
    }, root)
    let rows = await readRows(observationFile(root, 's-restart'))
    assert.equal(rows.length, 2)
    assert.equal(rows[1].surface.messageChange, 'appended', '重启后靠消息链种子判追加')
    assert.equal(rows[1].surface.epoch, 0)
    assert.equal(rows[1].surface.phase, 'append')

    // 再来一个进程：把第一条换掉（模拟离线期间的压缩）→ epoch 前移，定位不了首次差异
    await withEngine(async ({ ctx, engine }) => {
      await warmUp({ ctx, engine, session })
      const rewritten = [userMsg('回执'), assistantMsg('答一')]
      await preStep({ ctx, engine, session, turn: 1, step: 3, messages: rewritten })
      pushAssistant(session, { turn: 1, step: 3, usage: { inputTokens: 12, outputTokens: 1 } })
      await preStep({ ctx, engine, session, turn: 1, step: 4, messages: [...rewritten, assistantMsg('答三')] })
    }, root)
    rows = await readRows(observationFile(root, 's-restart'))
    assert.equal(rows.length, 3)
    assert.equal(rows[2].surface.messageChange, 'message-prefix-rewritten')
    assert.equal(rows[2].surface.epoch, 1, '跨进程代际链必须接上')
    assert.equal(rows[2].surface.phase, 'epoch-start')
    assert.equal(rows[2].surface.firstDivergence, null, '跨进程只有消息链，不伪造首次差异位置')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------- W6 失败不推进

test('W6 落盘失败不推进前值：下一次成功观测按更早的投影比较，epoch 不丢', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-fail')
    await warmUp({ ctx, engine, session })
    const base = [userMsg('原始问句')]
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: base })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: [...base, assistantMsg('答')] })

    // 第 2 步：投影被改写成 B；让账本写入失败（文件变目录）
    const rewritten = [userMsg('被压缩后的回执')]
    await preStep({ ctx, engine, session, turn: 2, step: 1, messages: rewritten })
    pushAssistant(session, { turn: 2, step: 1, usage: { inputTokens: 10, outputTokens: 1 } })
    const file = observationFile(dir, 's-fail')
    const text = await readFile(file, 'utf8')
    await rm(file, { force: true })
    await mkdir(file, { recursive: true })
    await preStep({ ctx, engine, session, turn: 2, step: 2, messages: rewritten })
    await rm(file, { recursive: true, force: true })
    await assert.rejects(() => readFile(file, 'utf8'), (e) => e?.code === 'ENOENT')

    // 第 3 步：B + 追加，写入恢复 → 必须相对第 1 步判「改写」，不是「追加」
    const next = [...rewritten, userMsg('新一句')]
    await preStep({ ctx, engine, session, turn: 2, step: 3, messages: next })
    pushAssistant(session, { turn: 2, step: 3, usage: { inputTokens: 10, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 2, step: 4, messages: [...next, assistantMsg('答')] })

    const written = await readFile(file, 'utf8')
    const rows = written.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const recovered = rows.at(-1)
    // 失败的观测没有落行，断点由 seq 幂等推进；成功的那条仍按第 1 条投影比较
    assert.equal(recovered.surface.messageChange, 'message-prefix-rewritten', '失败行不得把前值推进到 B')
    assert.equal(recovered.surface.epoch, 1)
    assert.ok(text.length > 0)
  })
})

// ---------------------------------------------------------------- W7 快照失败

test('W7 pre-step 快照失败不影响摄入：surface 记未知，其余字段照写', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-snapshotfail')
    await warmUp({ ctx, engine, session })
    session.deriveMessages = () => { throw new Error('derive boom') }
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: [] })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 2 } })
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: [] })

    const rows = await readRows(observationFile(dir, 's-snapshotfail'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].surface, null)
    assert.equal(rows[0].request.turn, 1)
    assert.equal(rows[0].usage.inputTokens.value, 7)
    assert.ok(ctx.warns.some((line) => line.includes('投影快照失败')), '快照失败必须可见')
    const info = await engine.inspect('s-snapshotfail')
    assert.equal(info.lastSeq, session.log.length - 1, '摄入断点不受快照失败影响')
  })
})

// ---------------------------------------------------------------- W8 重放

test('W8 重放同一批事件不重复写、不重复推进代际', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const session = fakeSession('s-replay')
    await warmUp({ ctx, engine, session })
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: [userMsg('问')] })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: [userMsg('问'), assistantMsg('答')] })
    await ctx.callPreStep({ session }, { turn: 1, step: 2 })
    await engine._waitForIdle()
    await ctx.callPreStep({ session }, { turn: 1, step: 2 })
    await engine._waitForIdle()
    const rows = await readRows(observationFile(dir, 's-replay'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].surface.epoch, 0)
  })
})

// ---------------------------------------------------------------- W9 不参与决策

test('W9 观测不进入决策面：导入级 + 符号级判据（定点变异自证）', async () => {
  // ---- 量具自检：扫描面非空，且真的读到了仓库里那两条观测导入边
  const real = await observationImportScan(V3_SRC)
  assert.ok(real.files >= 20, '扫描面过小（' + real.files + ' 个 .mjs），守卫会恒绿')
  assert.ok(real.relativeImports >= 40, '未解析到足够的相对 import（' + real.relativeImports + '），正则可能失配')
  assert.deepEqual(real.violations, [], '真实树不得有观测模块越界导入')
  assert.deepEqual(real.importers, ['adapters/storage/usage-log.mjs', 'entry/v3-entry.mjs'], '量具必须看到真实的观测导入边（账本→合同、入口→两者）')

  const realEntry = path.join(V3_SRC, 'entry', 'v3-entry.mjs')
  const realSymbols = entryObservationSymbolAudit(await readFile(realEntry, 'utf8'))
  assert.deepEqual(realSymbols.violations, [], 'entry 的观测符号不得跑进归档/调度函数')
  for (const [name, count] of Object.entries(realSymbols.counts)) {
    assert.ok(count >= (name === 'cacheProjection' ? 2 : 1), '符号量具自检：' + name + ' 只扫到 ' + count + ' 处，守卫可能失配')
  }

  // ---- 定点变异：在副本里改坏，守卫必须点名；真仓文件哈希前后一致
  const realFiles = [
    path.join(V3_SRC, 'application', 'archive.mjs'),
    path.join(V3_SRC, 'domain', 'session', 'mode.mjs'),
    realEntry,
  ]
  const before = await Promise.all(realFiles.map(fileSha256))
  const tmp = await mkdtemp(path.join(tmpdir(), 'mcl-w9-'))
  const copyRoot = path.join(tmp, 'v3')
  try {
    await cp(V3_SRC, copyRoot, { recursive: true })
    // 防误杀对照：未改动的副本必须与真仓同结论（0 违规）
    const clean = await observationImportScan(copyRoot)
    assert.deepEqual(clean.violations, [], '未改动的副本不得误报')
    assert.deepEqual(clean.importers, real.importers)

    const copyArchive = path.join(copyRoot, 'application', 'archive.mjs')
    const copyDomain = path.join(copyRoot, 'domain', 'session', 'mode.mjs')
    const copyEntry = path.join(copyRoot, 'entry', 'v3-entry.mjs')

    // 变异 A：决策层 import 观测合同（审计实测 W9 当时仍绿的形态）
    await writeFile(copyArchive, (await readFile(copyArchive, 'utf8'))
      + "\nimport { nextProjectionEpoch } from '../contracts/cache-observation.mjs'\n", 'utf8')
    // 变异 B：domain 层同样越界
    await writeFile(copyDomain, (await readFile(copyDomain, 'utf8'))
      + "\nimport { projectionSeedOf } from '../../contracts/cache-observation.mjs'\n", 'utf8')
    // 变异 C：application 反向导入入口（entry 的 cacheProjection 来源）
    await writeFile(copyArchive, (await readFile(copyArchive, 'utf8'))
      + "\nimport { attachV3Engine } from '../entry/v3-entry.mjs'\n", 'utf8')

    const mutatedImports = await observationImportScan(copyRoot)
    assert.ok(mutatedImports.violations.some((v) => v.file === 'application/archive.mjs' && v.target === 'contracts/cache-observation.mjs'),
      'archive 里 import 观测合同必须红')
    assert.ok(mutatedImports.violations.some((v) => v.file === 'domain/session/mode.mjs' && v.target === 'contracts/cache-observation.mjs'),
      'domain 里 import 观测合同必须红')
    assert.ok(mutatedImports.violations.some((v) => v.file === 'application/archive.mjs' && v.target === 'entry/v3-entry.mjs'),
      'application 反向导入 entry 必须红')

    // 变异 D：entry 把观测前值塞进归档参数（符号级）
    const entrySource = await readFile(copyEntry, 'utf8')
    const anchor = 'const stepArgs = {'
    assert.ok(entrySource.includes(anchor), '变异锚点必须存在（守卫自检）')
    const eol = entrySource.includes('\r\n') ? '\r\n' : '\n'
    await writeFile(copyEntry, entrySource.replace(anchor, anchor + eol + '        cacheProjection: entry.cacheProjection,'), 'utf8')
    const mutatedSymbols = entryObservationSymbolAudit(await readFile(copyEntry, 'utf8'))
    assert.ok(mutatedSymbols.violations.some((v) => v.name === 'cacheProjection' && v.function === 'runArchiveForStep'),
      '观测前值进入归档参数必须红（实际：' + JSON.stringify(mutatedSymbols.violations) + '）')

    // 复原：删副本后真仓哈希不变
    await rm(tmp, { recursive: true, force: true })
    const after = await Promise.all(realFiles.map(fileSha256))
    assert.deepEqual(after, before, '定点变异只发生在副本，真仓文件不得被改动')
    assert.deepEqual((await observationImportScan(V3_SRC)).violations, [], '复原后必须复绿')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------- W10 跳过行

test('W10 seq 回退的跳过行（有快照）不落账、不推进内存代际', async () => {
  await withEngine(async ({ dir, ctx, engine }) => {
    const sid = 's-skip'
    const session = fakeSession(sid)
    // 账本里**已有** seq 0（重启/回滚后重放会撞上它）：内容「旧面」，epoch 0。
    // 这是真正的「seq 回退 + 有快照」场景：重放事件的 seq 小于账本尾部。
    const seeded = await appendCacheObservation(path.join(dir, 'sessions', sid), 0, {
      usage: { inputTokens: 5, outputTokens: 1 },
      at: 1700000000000,
      request: { turn: 0, step: 0 },
      surface: { messages: [userMsg('旧面')] },
      surfaceCoverage: { system: false, tools: false },
      surfaceSnapshot: 'pre-step',
    })
    assert.equal(seeded.ok, true, JSON.stringify(seeded))
    assert.equal(seeded.projection.epoch, 0)

    await warmUp({ ctx, engine, session })
    // 第 1 步快照是**改写后**的面（与账本种子不同）；事件 seq 0 会被跳过分支挡下。
    await preStep({ ctx, engine, session, turn: 1, step: 1, messages: [userMsg('新面')] })
    pushAssistant(session, { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } })
    // 第 2 步内容回到账本真相「旧面」：若跳过分支推进了内存前值，这里会被判成改写。
    await preStep({ ctx, engine, session, turn: 1, step: 2, messages: [userMsg('旧面')] })
    pushAssistant(session, { turn: 1, step: 2, usage: { inputTokens: 1, outputTokens: 1 } })
    await preStep({ ctx, engine, session, turn: 1, step: 3, messages: [userMsg('旧面')] })

    const rows = await readRows(observationFile(dir, sid))
    assert.equal(rows.length, 2, '跳过行不得落账（种子行 + 第 2 步一行）')
    const last = rows.at(-1)
    assert.equal(last.surface.epoch, 0, '未落账的投影不得成为内存前值（否则 epoch 多推进）')
    assert.equal(last.surface.phase, 'steady')
    assert.equal(last.surface.messageChange, 'unchanged')
    const info = await engine.inspect(sid)
    assert.equal(info.lastSeq, 1, '跳过只影响观测前值，不影响摄入断点')
  })
})
