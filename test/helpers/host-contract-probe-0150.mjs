#!/usr/bin/env node
/**
 * 0.15.0 P0 宿主合同探针（源码级，2026-10-31；返工版：精确提取/可鉴别判据）。
 *
 * 目标宿主：DSH 0.2.1-rc.5（`<resources>/app.asar` 内 `dsh/package.json` 实测）。
 * 只读 app.asar，不启动宿主、不读 profile/会话库、不操作 GUI；不依赖第三方包
 * （Electron 把 app.asar 当目录，普通 node 必须自己解析 asar 头）。
 *
 * 与既有 test/helpers/host-contract-probe.mjs 的分工：那支探针管 0.14.0 已消费的
 * 字段；本探针管 0.15.0 P0 的七项。**每条 PASS 都必须是「改一行关键内容就会 FAIL」
 * 的判据**；无法机械证明的只做源码定位提示（LOCATE），不计入 PASS 契约。
 * 请求深冻结不单独作为 PASS：本探针只证明「外壳 Object.freeze + loop 标记」；
 * 「每条 boundaryMessage 逐个 deepFreeze + 数组 Object.freeze」只作 LOCATE。
 * （2026-11-01 复核：rc.5 实际形状是 `for (const message of boundaryMessages) deepFreeze(message)`
 *   再 `Object.freeze(boundaryMessages)`，**没有**字面量 `deepFreeze(boundaryMessages)`；
 *   旧 LOCATE 按该字面量搜，必然 LOCATE-MISS，是探针误报，不是宿主漂移。）
 *
 * ## 判据来源
 * 宿主源码：dsh-agent-loop、dsh-session、dsh-tools、dsh-scope、dsh-llm、
 * dsh-llm-deepseek、dsh-llm-pi-ai、dsh-token-meter（0.2.1-rc.5，2026-10-31 提取）。
 * 行号会漂：断言一律按符号/结构提取，不钉行号。
 *
 * ## 不适用条件与已知边界
 * - 源码事实 ≠ 真实集成：不证明运行时时序、不证明 GUI 行为。
 * - 精确提取仍是静态文本级；宿主改写成等价不同代码时会 FAIL，不会静默绿。
 * - 未提供 --asar/DSH_ASAR → SKIP（退出 0）；显式给了 --asar 但缺值 → 用法错误（退出 2）。
 *
 * ## 运行命令与退出码
 *   node test/helpers/host-contract-probe-0150.mjs --asar "<resources>/app.asar"
 *   DSH_ASAR="<...>" node test/helpers/host-contract-probe-0150.mjs
 *   0 = 全部 PASS 或 SKIP；1 = 契约漂移/manifest 不可解析/包缺失；2 = 用法或 asar 结构错误。
 * 输出契约：固定顺序、LF、不含绝对路径；两次运行 stdout 逐字节相同。
 */
import fs from 'node:fs'

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const explicitAsar = process.argv.includes('--asar')
const cliAsar = argOf('--asar')
// 显式 --asar 缺值必须先独立判错：不能被 DSH_ASAR 兜底成功。
if (explicitAsar && (typeof cliAsar !== 'string' || cliAsar.trim().length === 0 || cliAsar.startsWith('--'))) {
  console.error('[probe:host-0150] 用法错误：--asar 必须带值（要 SKIP 请完全省略该参数）')
  process.exit(2)
}
const asar = explicitAsar ? cliAsar : process.env.DSH_ASAR
if (!explicitAsar && (typeof asar !== 'string' || asar.trim().length === 0)) {
  console.log('[probe:host-0150] SKIP：未提供 --asar / DSH_ASAR。示例：node test/helpers/host-contract-probe-0150.mjs --asar "<DSH>/resources/app.asar"')
  process.exit(0)
}
if (!fs.existsSync(asar)) {
  console.error('[probe:host-0150] 找不到 app.asar（路径已省略）：请确认 --asar 指向 DSH 安装目录下的 resources/app.asar')
  process.exit(2)
}

/** 解析 asar：uint32 pickle 大小 + pickle + uint32 头长 + JSON 头；数据从 8+pickle 起。 */
function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  if (fs.readSync(fd, head, 0, 16, 0) < 16) throw new Error('asar 头不足 16 字节')
  const dataStart = 8 + head.readUInt32LE(4)
  const jsonLength = head.readUInt32LE(12)
  const header = Buffer.alloc(jsonLength)
  fs.readSync(fd, header, 0, jsonLength, 16)
  const tree = JSON.parse(header.toString('utf8'))
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = prefix ? prefix + '/' + name : name
      if (value.files) walk(value, full)
      else entries.set(full, { offset: Number(value.offset), size: Number(value.size) })
    }
  }
  walk(tree, '')
  return {
    read(entry) {
      const found = entries.get(entry)
      if (found === undefined) throw new Error('asar 内没有 ' + entry)
      const buffer = Buffer.alloc(found.size)
      if (found.size > 0) fs.readSync(fd, buffer, 0, found.size, dataStart + found.offset)
      return buffer.toString('utf8')
    },
    close() { fs.closeSync(fd) },
  }
}

let archive
try {
  archive = openAsar(asar)
} catch (error) {
  console.error('[probe:host-0150] asar 解析失败（路径已省略）：' + (error?.code ?? 'EASAR'))
  process.exit(2)
}
const entries = {
  manifest: 'dsh/package.json',
  loop: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
  session: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  tools: 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  scope: 'dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js',
  llm: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  llmTypes: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js',
  llmDeepseek: 'dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
  llmPi: 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  tokenMeter: 'dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js',
}

const source = {}
const missingFiles = []
for (const [key, entry] of Object.entries(entries)) {
  try {
    source[key] = archive.read(entry)
  } catch {
    missingFiles.push(key)
  }
}
archive.close()
if (missingFiles.length > 0) {
  console.error('[probe:host-0150] 宿主包缺失：' + missingFiles.join(', '))
  process.exit(1)
}

// 变异自证用：HOST_PROBE_SELFTEST=1 时把源包交由内建变异器改写后再跑（不落盘、不联网）。
if (process.env.HOST_PROBE_SELFTEST === '1') {
  const target = process.env.HOST_PROBE_MUTATION
  const mutated = mutateSource(source, target)
  if (mutated === false) {
    console.error('[probe:host-0150] 自检变异目标无效：' + String(target))
    process.exit(2)
  }
  for (const key of Object.keys(mutated)) source[key] = mutated[key]
}

// manifest 是版本证据：坏 JSON / 缺 version 一律失败关闭，不得 unknown 后全 PASS。
let version
try {
  const manifest = JSON.parse(source.manifest)
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw new Error('manifest 缺 version')
  version = manifest.version
} catch {
  console.error('[probe:host-0150] dsh/package.json 无法解析或缺 version（失败关闭）')
  process.exit(1)
}

/**
 * 内建变异器：只做小范围字符串替换，用于证明「改关键内容 → 对应 FAIL」。
 * 返回 false 表示目标/锚点不存在（自检用法错误，exit 2），不静默放过。
 */
function mutateSource(current, target) {
  const next = { ...current }
  const replaceOnce = (key, from, to) => {
    if (!next[key].includes(from)) return false
    next[key] = next[key].replace(from, to)
    return true
  }
  switch (target) {
    case 'manifest-bad-json':
      next.manifest = '{ not valid json'
      return next
    case 'manifest-no-version':
      return replaceOnce('manifest', '"version"', '"versionRemoved"') ? next : false
    case 'deepseek-drop-cache-write':
      return replaceOnce('llmDeepseek', 'cache_creation_input_tokens: "cacheWriteTokens"', 'cache_creation_input_tokens: "cacheWriteTokensDropped"') ? next : false
    case 'surface-add-tool-call':
      return replaceOnce('session', '"tool/result"\n]);', '"tool/result",\n\t"tool/call"\n]);') ? next : false
    case 'order-swap': {
      // 把 pre-step 调用挪到 step/start 之后：直接删掉前一处，再插到 append 之后。
      const marker = 'const decision = await this.preStep(target, {'
      const start = next.loop.indexOf(marker)
      const end = next.loop.indexOf('signal.throwIfAborted();', start)
      if (start === -1 || end === -1) return false
      const call = next.loop.slice(start, end)
      const without = next.loop.slice(0, start) + next.loop.slice(end)
      const stepStart = without.indexOf('this.session.append("step/start", {')
      const close = without.indexOf('});', stepStart)
      if (stepStart === -1 || close === -1) return false
      next.loop = without.slice(0, close + 3) + '\n' + call + without.slice(close + 3)
      return next
    }
    case 'freeze-remove':
      return replaceOnce('loop', 'return markAgentLoopRequest(Object.freeze({', 'return markAgentLoopRequest(({') ? next : false
    default:
      return false
  }
}


/**
 * 提取单个顶层声明体：从 needle 起，按 { } / ( ) / [ ] 配对截到闭合，
 * 避免「整文件正则碰巧命中」与注释误命中。
 */
function blockAt(text, needle, opener = '{', closer = '}') {
  const start = text.indexOf(needle)
  if (start === -1) return null
  const open = text.indexOf(opener, start)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 单条字符串字面量集合的提取（用于 Set([...]) / 数组）。 */
function literalsIn(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
}

/** 代码块（不含注释）——用于「注释不能作为行为证明」。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const checks = [
  // 1. pre-step → next → 工具结果 → 下一请求 顺序
  ['agent-loop: pre-step 在 append step/start 之前 await',
    () => {
      const turn = blockAt(source.loop, '	async turn()')
      if (turn === null) return false
      const preStep = turn.indexOf('await this.preStep(target,')
      const stepStart = turn.indexOf('this.session.append("step/start"')
      return preStep !== -1 && stepStart !== -1 && preStep < stepStart
    }],
  ['agent-loop: 请求派生自 session.deriveMessages（surface 投影）',
    () => {
      const build = blockAt(source.loop, '	buildRequest(')
      return build !== null && build.includes('session.deriveMessages()')
    }],
  ['agent-loop: 工具结果以 surfaceOp append + sourceEventSeqs:[callSeq] 落盘',
    () => {
      const fn = blockAt(source.loop, 'function appendToolResult(')
      return fn !== null && fn.includes('session.append("tool/result"')
        && fn.includes('surfaceOp: "append"') && fn.includes('sourceEventSeqs: [callSeq]')
    }],
  ['agent-loop: tool/call 先于结果落盘（appendToolCall 返回 callSeq）',
    () => {
      const fn = blockAt(source.loop, 'function appendToolCall(')
      return fn !== null && fn.includes('return session.append("tool/call"')
        && fn.includes('}).seq')
    }],
  ['agent-loop: 结果按模型顺序提交（commitReady 从 committed 起）',
    () => {
      const group = blockAt(source.loop, 'async function runGroup(')
      if (group === null) return false
      const ready = blockAt(group, 'const commitReady = async () =>')
      return ready !== null && ready.includes('while (committed < group.length)')
        && ready.includes('slots[committed]')
    }],

  // 2. surface replace
  ['session: surface 事件类型集合恰为 5 个且不含 tool/call',
    () => {
      const set = blockAt(source.session, 'const SURFACE_EVENT_TYPES = new Set(', '[', ']')
      if (set === null) return false
      const names = literalsIn(set)
      return names.length === 5
        && names.includes('system/message') && names.includes('developer/message')
        && names.includes('user/message') && names.includes('assistant/message')
        && names.includes('tool/result') && !names.includes('tool/call')
    }],
  ['session: replace 区间按活动面 index 判序（允许数值倒序）',
    () => {
      const fn = blockAt(source.session, 'function replacementRange(')
      if (fn === null) return false
      const startIdx = fn.indexOf('state.nodes.indexOf(op.startSeq)')
      const endIdx = fn.indexOf('state.nodes.indexOf(op.endSeq)')
      const guard = fn.indexOf('startIdx > endIdx')
      return startIdx !== -1 && endIdx !== -1 && guard !== -1
        && startIdx < endIdx && endIdx < guard && !fn.includes('startSeq > endSeq')
    }],
  ['session: sourceEventSeqs 密集覆盖被遮蔽节点',
    () => {
      const fn = blockAt(source.session, 'function assertSourceEventReferences(')
      return fn !== null
        && fn.includes('const missing = shadowedSeqs.filter((seq) => !sources.has(seq))')
        && fn.includes('missing.length > 0')
    }],
  ['session: tool/result 替换仅允许改 content、仅 1 个当前节点',
    () => {
      const fn = blockAt(source.session, 'function assertToolResultRewrite(')
      if (fn === null) return false
      return fn.includes('shadowedSeqs.length !== 1')
        && fn.includes('original?.type !== "tool/result"')
        && fn.includes('content: null')
        && fn.includes('isDeepEqualJson(originalRest, replacementRest)')
        && fn.includes('may change only content')
    }],
  ['session: node 0 系统提示只能由 system/message 改写',
    () => {
      const fn = blockAt(source.session, 'function assertSystemHeadRewrite(')
      return fn !== null && fn.includes('startIdx !== 0') && fn.includes('event.type !== "system/message"')
        && fn.includes('shadowedSeqs.length !== 1')
    }],
  ['session: assistant/message 不得携带 sourceEventSeqs',
    () => {
      const fn = blockAt(source.session, 'function assertSourceEventReferences(')
      return fn !== null && fn.includes('event.type === "assistant/message" && raw !== void 0')
        && fn.includes('cannot carry sourceEventSeqs')
    }],

  // 3. 工具注册 / 取消 / 来源
  ['tools: register 返回 ctx.effect 绑定的精确 disposer',
    () => {
      const fn = blockAt(source.tools, '	register(definition)')
      return fn !== null
        && fn.includes('return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition)')
        && fn.includes('label: "tools.register()"')
    }],
  ['tools: schema 顺序取 visible.values()（插入序，不排序）',
    () => {
      const fn = blockAt(source.tools, '	wireSchemas(scope)')
      return fn !== null && fn.includes('[...view.visible.values()].map(')
        && !fn.includes('.sort(')
    }],
  ['scope: NamedEntries 以 Map 插入序迭代并以 delete 撤销',
    () => {
      const cls = blockAt(source.scope, 'var NamedEntries = class')
      return cls !== null && /data = [\s\S]{0,40}new Map\(\)/.test(cls)
        && cls.includes('keys() {') && cls.includes('return this.data.keys();')
        && cls.includes('entries() {') && cls.includes('return this.data.entries();')
        && cls.includes('values() {') && cls.includes('return this.data.values();')
        && cls.includes('data.delete(name);')
    }],
  ['agent-loop: 工具集变化写 developer/message（tool-addition/removal）',
    () => {
      const build = blockAt(source.loop, '	buildRequest(')
      return build !== null && build.includes('type: "tool-addition"')
        && build.includes('type: "tool-removal"')
        && build.includes('session.append("developer/message"')
        && build.includes('surfaceOp: "append"')
    }],

  // 4. usage
  ['llm: TokenUsage 字段（后四个可选）',
    () => {
      const m = source.llmTypes.match(/"name": "TokenUsage"[\s\S]{0,400}?"declaration": "(export interface TokenUsage[\s\S]*?)"/)
      if (m === null) return false
      const decl = JSON.parse('"' + m[1].replace(/"/g, '\\"').replace(/\\n/g, '\\n') + '"')
      return decl.includes('inputTokens: number;') && decl.includes('outputTokens: number;')
        && decl.includes('totalTokens?: number;') && decl.includes('cacheReadTokens?: number;')
        && decl.includes('cacheWriteTokens?: number;') && decl.includes('reasoningTokens?: number;')
    }],
  ['llm-deepseek: 四个 wire 字段映射 + totalTokens 仅按已有字段求和',
    () => {
      const fn = blockAt(source.llmDeepseek, 'function updateUsage(')
      if (fn === null) return false
      const map = blockAt(fn, 'Object.entries({')
      if (map === null) return false
      const fields = ['input_tokens: "inputTokens"', 'output_tokens: "outputTokens"',
        'cache_read_input_tokens: "cacheReadTokens"', 'cache_creation_input_tokens: "cacheWriteTokens"']
      const allMapped = fields.every((entry) => map.includes(entry))
      const total = source.llmDeepseek.includes('usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)')
      return allMapped && total
    }],
  ['llm-deepseek: usage 字段缺省即不写（continue）',
    () => {
      const fn = blockAt(source.llmDeepseek, 'function updateUsage(')
      return fn !== null && fn.includes('const value = fields[wire];') && fn.includes('if (value === void 0) continue;')
    }],
  ['llm-pi-ai: cache 字段仅 >0 出现（缺失语义）',
    () => {
      const fn = blockAt(source.llmPi, 'function mapUsage(')
      return fn !== null && fn.includes('...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}')
        && fn.includes('...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}')
        && !fn.includes('reasoningTokens')
    }],
  ['token-meter: 会话权威 usage = assistant/message.data.usage',
    () => {
      const fn = blockAt(source.tokenMeter, 'function usageOf(event)')
      return fn !== null && fn.includes('event.type === "assistant/message" && event.data.usage !== void 0')
    }],

  // 5. 最终请求观测
  ['llm: llm/stream 是公开 waterfall，接收完整请求',
    () => {
      const fn = blockAt(source.llm, 'streamWithRegistration(options, prepared)')
      return fn !== null && fn.includes('this.ctx.waterfall(this, "llm/stream", options')
    }],
  ['agent-loop: 请求外壳 Object.freeze + loop 标记（深冻结另见 LOCATE）',
    () => {
      const build = blockAt(source.loop, '	buildRequest(')
      if (build === null) return false
      return build.includes('return markAgentLoopRequest(Object.freeze({')
        && build.includes('messages: boundaryMessages')
    }],

  // 6. 首次结果入模 seam
  ['agent-loop: pre-step 每次请求前运行（下一请求会先 await pre-step）',
    () => {
      const turn = blockAt(source.loop, '	async turn()')
      if (turn === null) return false
      const loop = turn.indexOf('while (true) {')
      const preStep = turn.indexOf('await this.preStep(target,')
      return loop !== -1 && preStep > loop
    }],
  ['agent-loop: step 内重试不重新走 pre-step',
    () => {
      const step = blockAt(source.loop, '	async step(decision)')
      if (step === null) return false
      return step.includes('while (true) {') && step.includes('await this.prepareRequest(turn, step, signal)')
        && !step.includes('preStep(')
    }],

  // 7. 调用闭包形状
  ['agent-loop: 调用全集来自 assistant 内容块 type==="tool-call"',
    () => {
      const step = blockAt(source.loop, '	async step(decision)')
      return step !== null && step.includes('const toolCalls = message.content.filter((block) => block.type === "tool-call")')
    }],
  ['agent-loop: 取消为未启动调用补 call/result 对',
    () => {
      const fn = blockAt(source.loop, 'function appendSkippedToolCall(')
      return fn !== null && fn.includes('appendToolCall(session, turn, step, block)')
        && fn.includes('appendToolResult(')
    }],
  ['session: ToolCallRecovery 按 assistant 顺序补结果',
    () => {
      const cls = blockAt(source.session, 'var ToolCallRecovery = class')
      if (cls === null) return false
      const results = blockAt(cls, '	results()')
      return results !== null && results.includes('for (const [callId, { turn, step, callSeq }] of this.pendingCalls)')
        && cls.includes('new Map()')
    }],
  ['session: 崩溃收尾先补结果，再 step/end、turn/end',
    () => {
      const fn = blockAt(source.session, 'function openTurnClosers(')
      if (fn === null) return false
      const results = fn.indexOf('const closers = recovery.results()')
      const stepEnd = fn.indexOf('type: "step/end"')
      const turnEnd = fn.indexOf('type: "turn/end"')
      return results !== -1 && stepEnd !== -1 && turnEnd !== -1 && results < stepEnd && stepEnd < turnEnd
    }],
]

/**
 * 名称与行为无法机械绑定、或只在注释里出现的项：只报 LOCATE（源码定位提示），
 * 不计入 PASS 契约，也不影响退出码。
 */
const locates = [
  ['llm-pi-ai: reasoning 折进 output（仅注释说明，非行为断言）',
    () => source.llmPi.includes('Map pi-ai usage (reasoning folded into output by pi-ai)')],
  ['agent-loop: 请求消息逐条 deepFreeze + 数组 Object.freeze（辅助定位，非 PASS 契约）',
    () => {
      const at = source.loop.indexOf('const boundaryMessages = session.deriveMessages()')
      if (at === -1) return false
      const window = source.loop.slice(at, at + 600)
      return window.includes('deepFreeze(message)') && window.includes('Object.freeze(boundaryMessages)')
    }],
]

const failed = []
for (const [label, check] of checks) {
  let ok = false
  try { ok = check() === true } catch { ok = false }
  console.log((ok ? 'PASS ' : 'FAIL ') + label)
  if (!ok) failed.push(label)
}
for (const [label, check] of locates) {
  let ok = false
  try { ok = check() === true } catch { ok = false }
  console.log((ok ? 'LOCATE ' : 'LOCATE-MISS ') + label)
}
console.log('[probe:host-0150] dsh=' + version + ' checks=' + checks.length + ' failed=' + failed.length + ' locates=' + locates.length)
if (failed.length > 0) {
  console.error('[probe:host-0150] 宿主契约漂移：' + failed.join('；'))
  process.exit(1)
}
console.log('[probe:host-0150] PASS：0.15.0 P0 七项契约仍在（源码级，不替代真实集成）')