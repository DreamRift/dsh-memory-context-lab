/**
 * 证据原子提取（P3-1/2/3，纯函数、零 IO）。
 *
 * 层级压缩的第一层：把已归档的 L0 跨度正文解析回结构化事件，再从**已知工具的
 * 结构事件**里提取类型化事实原子——命令、路径/符号、退出码、测试项目、错误签名、
 * 版本、时间。未知工具的文本不硬解析，走保守摘录（原句首尾行）；字段缺失标
 * "unknown"，绝不把「没有失败信号」猜成「成功」（计划 §5 P3-1）。
 *
 * 事实去重（P3-2）：原子以 (scope, entity, attribute, qualifier, value, polarity)
 * 为键——完全相同只合并来源引用；数值/否定/版本差异保留为更正或冲突；**相同输出
 * 的两次执行仍保留两次事件身份**（两个 sourceRef，不吞并）。
 *
 * 分桶归组（P3-3）：先按 session→phase→artifact→kind 分桶，桶内先精确键归组
 * （近线性），剩余做 Jaccard 近似归组，候选对数有硬上限——相似度只组织候选，
 * 不裁定事实对错；截断如实上报。
 *
 * 全部函数确定性：无随机、无时间读数（时间字段来自记录自身 createdAt）、
 * 无环境依赖。
 */

import { createHash } from 'node:crypto'

import { extractCallLocator } from '../core.mjs'
import { SPAN_KINDS } from './history.mjs'
import { extractClaims } from './claims.mjs'

/** 原子/事实的属性类别（封闭集；扩集须同步升 hierarchy schema 语义）。 */
export const ATOM_ATTRIBUTES = Object.freeze({
  EXIT_CODE: 'exit-code',
  COMMAND: 'command',
  TEST_SUMMARY: 'test-summary',
  ERROR_SIGNATURE: 'error-signature',
  VERSION: 'version',
  TIME: 'time',
  EXCERPT: 'excerpt',
  SPAN_EXCERPT: 'span-excerpt',
  /** S1：assistant 结论行（claim≠事实，默认 unverified，见 claims.mjs 铁律）。 */
  CLAIM: 'claim',
})

/** 属性 → 归组家族（分桶用的 kind 面）。 */
export const ATTRIBUTE_FAMILY = Object.freeze({
  [ATOM_ATTRIBUTES.EXIT_CODE]: 'outcome',
  [ATOM_ATTRIBUTES.TEST_SUMMARY]: 'outcome',
  [ATOM_ATTRIBUTES.ERROR_SIGNATURE]: 'outcome',
  [ATOM_ATTRIBUTES.COMMAND]: 'command',
  [ATOM_ATTRIBUTES.VERSION]: 'version',
  [ATOM_ATTRIBUTES.TIME]: 'time',
  [ATOM_ATTRIBUTES.EXCERPT]: 'excerpt',
  [ATOM_ATTRIBUTES.SPAN_EXCERPT]: 'excerpt',
  [ATOM_ATTRIBUTES.CLAIM]: 'claim',
})

/**
 * 近似归组的候选对硬上限（计划 §3：候选数量对数复杂度——不是全量 O(n²)）。
 * 超限截断并如实上报，不静默假装归组完整。
 */
export const GROUP_MAX_CANDIDATE_PAIRS = 4096
/** 单桶超过该成员数时，近似比较退化为「与最近 COMPARE_WINDOW 个代表比较」。 */
export const MAX_BUCKET_SIZE = 64
export const COMPARE_WINDOW = 8
/** Jaccard 相似度阈值：达到即并入同组（只组织候选，不裁定事实）。 */
export const GROUP_SIMILARITY_THRESHOLD = 0.6

/** 摘录行的单行/总长上限（保守摘录的界）。 */
export const EXCERPT_LINE_MAX_CHARS = 120
export const EXCERPT_MAX_CHARS = 240

// ---------------------------------------------------------------- 正文解析

/**
 * 反向解析 buildOperationBody（apply.mjs）生成的工具操作正文。
 *
 * 语法是对称的："[工具] <name>" 头、"参数：<args>" 行（args 可跨行）、
 * "[结果]"/"[失败结果]" 段头、"[推理]" 段头、首个标记之前的助手正文。
 * 行级状态机而不是按空行切段：参数 JSON 里可能出现空行，切段会把一条参数
 * 劈成两段。
 *
 * @returns {ok:true, assistantText, reasoning, entries:[{name, arguments, text, failed}]}
 *   或 {ok:false, reason}（正文里一个结构标记都没有时才判不可解析）。
 */
export function parseOperationBody(body) {
  if (typeof body !== 'string' || body.length === 0) return { ok: false, reason: 'empty' }
  const lines = body.split('\n')
  const assistantText = []
  let reasoning = null
  const entries = []
  let mode = 'pre'
  let current = null
  // 参数与结果正文在生成端都是 trim 过的（history.mjs buildOperationBody）；
  // 段落 '\n\n' join 会在段尾引入一条换行，这里剥掉它，保证反向解析逐字节还原。
  const pushEntry = () => {
    if (!current) return
    entries.push({
      name: current.name,
      arguments: current.arguments.replace(/\n+$/, ''),
      text: current.text.replace(/\n+$/, ''),
      failed: current.failed,
    })
    current = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '[推理]') {
      pushEntry()
      if (reasoning === null) reasoning = []
      mode = 'reasoning'
      continue
    }
    if (trimmed === '[结果]' || trimmed === '[失败结果]') {
      if (!current) continue
      current.failed = trimmed === '[失败结果]'
      current.text = ''
      mode = 'result'
      continue
    }
    const toolMatch = /^\[工具\]\s?(.*)$/.exec(trimmed)
    if (toolMatch) {
      pushEntry()
      current = { name: toolMatch[1].trim(), arguments: '', text: '', failed: false }
      mode = 'tool'
      continue
    }
    const argsMatch = /^参数：(.*)$/.exec(trimmed)
    if (argsMatch && current && (mode === 'tool' || mode === 'args')) {
      current.arguments = current.arguments ? current.arguments + '\n' + argsMatch[1] : argsMatch[1]
      mode = 'args'
      continue
    }
    if (mode === 'pre') {
      assistantText.push(line)
    } else if (mode === 'reasoning') {
      reasoning.push(line)
    } else if ((mode === 'tool' || mode === 'args') && current) {
      current.arguments = current.arguments ? current.arguments + '\n' + line : line
    } else if (mode === 'result' && current) {
      current.text = current.text ? current.text + '\n' + line : line
    }
  }
  pushEntry()
  const hasStructure = entries.length > 0 || reasoning !== null
  if (!hasStructure) return { ok: false, reason: 'no-structure-markers' }
  return {
    ok: true,
    assistantText: assistantText.join('\n').trim(),
    reasoning: reasoning === null ? '' : reasoning.join('\n').trim(),
    entries,
  }
}

/**
 * 反向解析普通历史段正文（spanBodyFor 生成："--- seq:N kind ---\n<text>\n\n…"）。
 * 只把「完全匹配头格式且 kind 是已知跨度种类」的行当头；正文里恰好长得像头的行
 * 只会被当成普通文本（误判只影响摘录切分，不影响事实本身）。
 */
export function parseSpanBody(body) {
  if (typeof body !== 'string' || body.length === 0) return { ok: false, reason: 'empty' }
  const spans = []
  let current = null
  for (const line of body.split('\n')) {
    const match = /^--- seq:(\d+) (\S+) ---$/.exec(line.trim())
    if (match && Object.values(SPAN_KINDS).includes(match[2])) {
      if (current) spans.push(current)
      current = { seq: Number(match[1]), kind: match[2], text: '' }
      continue
    }
    if (current) current.text = current.text ? current.text + '\n' + line : line
  }
  if (current) spans.push(current)
  if (spans.length === 0) return { ok: false, reason: 'no-span-headers' }
  return { ok: true, spans }
}

// ---------------------------------------------------------------- 类型化提取

/** 退出/错误信号：显式 exit code 或 isError 标记；都没有就是 null（unknown，不猜成功）。 */
export function readExitSignal(text) {
  const source = String(text ?? '')
  const exit = /(?:exit code|退出码)\s*[:：]?\s*(\d{1,3})/i.exec(source)
  if (exit) return { kind: 'exit', code: Number(exit[1]) }
  if (/"?(?:isError|is_error)"?\s*[:]\s*true/i.test(source)) return { kind: 'error' }
  return null
}

/** 测试项目计数（确定性正则族；认不出的行不贡献任何计数）。 */
export function parseTestSummary(text) {
  const source = String(text ?? '')
  const rows = source.split('\n')
  let total = 0
  let passed = 0
  let failed = 0
  for (const row of rows) {
    // BUG-011：一行里可能同时有通过数与失败数（"Tests: 3 passed | 2 failed"）。
    // 逐分支命中就 continue 会把 failed 永远留在 0，摘要据此报「全绿」——
    // 这正是模块红线禁止的「没有失败信号猜成成功」。所以先收集本行全部数字，
    // 再一次性聚合。
    let rowPassed = 0
    let rowFailed = 0
    let rowMatched = false
    let match
    // 中文形态：N 项全绿 / N 项失败 / N 项（含「通过」）
    if ((match = /(\d+)\s*项\s*全绿/.exec(row))) {
      rowPassed += Number(match[1])
      rowMatched = true
    }
    if ((match = /(\d+)\s*项\s*失败/.exec(row))) {
      rowFailed += Number(match[1])
      rowMatched = true
    }
    if (!rowMatched && (match = /(\d+)\s*项/.exec(row)) && /(通过|绿)/.test(row)) {
      rowPassed += Number(match[1])
      rowMatched = true
    }
    // 英文形态：收集所有 N passed / N failed（同行多数字不丢）
    for (const pass of row.matchAll(/(\d+)\s*pass(?:ed|es)?/gi)) {
      rowPassed += Number(pass[1])
      rowMatched = true
    }
    for (const fail of row.matchAll(/(\d+)\s*fail(?:ed|ing|s)?/gi)) {
      rowFailed += Number(fail[1])
      rowMatched = true
    }
    if (rowMatched) {
      const counted = rowPassed + rowFailed
      // 显式 "N tests" 同时出现时以两者较大值为总数：总数可能大于已说明的
      // 通过/失败之和（如 "5 tests, 3 passed"），此时后面的「全绿」必须不成立。
      const explicit = /(\d+)\s*tests?\b/i.exec(row)
      const explicitTotal = explicit ? Number(explicit[1]) : 0
      total += Math.max(counted, explicitTotal)
      passed += rowPassed
      failed += rowFailed
      continue
    }
    // 只有总数的行：N tests / 中文 N 项
    if ((match = /(\d+)\s*tests?\b/i.exec(row))) {
      total += Number(match[1])
      continue
    }
    if ((match = /(\d+)\s*项/.exec(row))) {
      total += Number(match[1])
    }
  }
  if (total === 0 && passed === 0 && failed === 0) return null
  const parts = [total + ' 项']
  if (passed > 0) parts.push(passed + ' 通过')
  if (failed > 0) parts.push(failed + ' 失败')
  if (failed > 0) parts.push('存在失败')
  else if (passed > 0 && total === passed) parts.push('全绿')
  else if (total > passed) parts.push('有项未说明结果')
  return { total, passed, failed, summary: parts.join('、') }
}

/** 版本号：版本关键字附近的数字段（值原样保留，不规范化）。 */
export function parseVersionTokens(text) {
  const source = String(text ?? '')
  const pattern = /(?:version|版本|node|npm|python|git|\bv)\s*[:=\s]\s*(\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.]+)?)/gi
  const found = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    if (!found.includes(match[1])) found.push(match[1])
    if (found.length >= 4) break
  }
  return found
}

/** 错误签名：首个错误/异常形态的行（截断保形，不改写）。 */
export function parseErrorSignature(text) {
  const rows = String(text ?? '').split('\n').filter((row) => row.trim().length > 0)
  for (const row of rows) {
    if (/\b(?:Error|Exception|TypeError|RangeError|SyntaxError)\b/.test(row) || /(?:错误|异常|失败原因)/.test(row)) {
      return clipExcerpt(row, EXCERPT_LINE_MAX_CHARS)
    }
  }
  return null
}

function clipExcerpt(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return codePointSlice(value, limit)
}

function codePointSlice(text, limit) {
  if (limit <= 0) return ''
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit).join('') + '…'
}

/** 保守摘录：首行 + 尾行（同一行只算一次），单行截断。未知工具文本走这里。 */
export function conservativeExcerpt(text) {
  const rows = String(text ?? '').split('\n').filter((row) => row.trim().length > 0)
  if (rows.length === 0) return ''
  const first = clipExcerpt(rows[0], EXCERPT_LINE_MAX_CHARS)
  const last = rows.length > 1 ? clipExcerpt(rows[rows.length - 1], EXCERPT_LINE_MAX_CHARS) : ''
  const joined = last ? first + '\n' + last : first
  return codePointSlice(joined, EXCERPT_MAX_CHARS)
}

function atomIdOf(key, sourceRefs) {
  const refText = sourceRefs
    .map((ref) => String(ref.recordId ?? '') + '|' + String(ref.callId ?? '') + '|' + String(ref.seq ?? 0))
    .join(',')
  return 'ea-' + createHash('sha256').update(key + '@' + refText, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 事实键：完全相同（同值同极性同限定词）才同键。数值/否定/版本差异天然分键，
 * 由 mergeFacts 按家族识别为更正或冲突。
 */
export function atomKey(atom) {
  return JSON.stringify([
    String(atom?.scope ?? 'session'),
    String(atom?.entity ?? ''),
    String(atom?.attribute ?? ''),
    atom?.qualifier ?? null,
    String(atom?.value ?? ''),
    atom?.polarity === 'negative' ? 'negative' : 'positive',
  ])
}

function familyKeyOf(atom) {
  return JSON.stringify([
    String(atom?.scope ?? 'session'),
    String(atom?.entity ?? ''),
    String(atom?.attribute ?? ''),
    atom?.qualifier ?? null,
  ])
}

function pushAtom(out, atom) {
  const value = atom?.value
  if (value === null || value === undefined || String(value).length === 0) return
  const sourceRefs = (Array.isArray(atom?.sourceRefs) ? atom.sourceRefs : []).filter(
    (ref) => ref && typeof ref === 'object',
  )
  if (sourceRefs.length === 0) return
  const scope = String(atom?.scope ?? 'session')
  const entity = String(atom?.entity ?? '')
  const attribute = String(atom?.attribute ?? ATOM_ATTRIBUTES.EXCERPT)
  // S1：claim 极性是五值封闭集（claims.mjs CLAIM_POLARITIES），其他属性保持
  // positive/negative 二值。五值里的 negated/retracted 映射语义与 negative 同向，
  // 但保留原值供上游区分（冲突判定按值全等）。
  const claimPolarities = new Set(['positive', 'negated', 'conditional', 'cited', 'retracted'])
  const rawPolarity = String(atom?.polarity ?? 'positive')
  const isClaimAtom = atom?.attribute === ATOM_ATTRIBUTES.CLAIM
  const polarity = isClaimAtom && claimPolarities.has(rawPolarity)
    ? rawPolarity
    : (rawPolarity === 'negative' ? 'negative' : 'positive')
  const qualifier = atom?.qualifier ?? null
  const key = atomKey({ scope, entity, attribute, value, polarity, qualifier })
  out.push({
    kind: 'atom',
    atomId: atomIdOf(key, sourceRefs),
    key,
    scope,
    entity,
    attribute,
    value: String(value),
    polarity,
    qualifier,
    sourceRefs,
    ...(atom?.pluginAuthored === true ? { pluginAuthored: true } : {}),
    ...(atom?.excerpt ? { excerpt: String(atom.excerpt) } : {}),
    // S1：claim 原子显式携带 unverified（缺省不写，兼容既有原子形状）。
    ...(isClaimAtom ? { verified: false } : {}),
  })
}

/**
 * 从一个已归档成员提取原子（P3-1）。
 *
 * member 形状（coordinator 从 store 归档行 + 冷库记录组装）：
 * {recordId, nodeId, spanKind, tools, callIds, range:{start,end}, body,
 *  pluginAuthored, createdAt, failed}——body 是归档时逐字节保存的 L0 正文；
 * failed 是配对结果里显式失败标记。
 *
 * 插件自产 span（pluginAuthored）原子照提（带 pluginAuthored 标记），由下游
 * 卡内容选择层排除——这里不做政策，只提事实。
 */
export function extractAtoms(member) {
  const atoms = []
  if (!member || typeof member.body !== 'string' || member.body.length === 0) return atoms
  const scope = member.scope ?? 'session'
  const baseRef = (callId) => ({
    recordId: member.recordId ?? null,
    nodeId: member.nodeId ?? null,
    callId: callId ?? null,
    seq: member.range?.start ?? member.seq ?? null,
    at: member.createdAt ?? null,
  })
  if (member.spanKind === SPAN_KINDS.OPERATION) {
    const parsed = parseOperationBody(member.body)
    if (!parsed.ok) {
      // 结构标记都没有：整段保守摘录，不做任何类型化断言。
      pushAtom(atoms, {
        scope,
        entity: (member.tools ?? [])[0] ?? 'operation',
        attribute: ATOM_ATTRIBUTES.EXCERPT,
        value: conservativeExcerpt(member.body),
        polarity: member.failed ? 'negative' : 'positive',
        sourceRefs: [baseRef(null)],
      })
      return atoms
    }
    const callIds = Array.isArray(member.callIds) ? member.callIds : []
    parsed.entries.forEach((entry, index) => {
      const callId = callIds[index] ?? null
      const refs = [baseRef(callId)]
      const entity = entityOfEntry(entry) || entry.name || 'tool'
      const signal = readExitSignal(entry.text)
      if (signal) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.EXIT_CODE,
          value: signal.kind === 'exit' ? 'exit ' + signal.code : 'error',
          polarity: signal.kind === 'error' || (signal.kind === 'exit' && signal.code !== 0) ? 'negative' : 'positive',
          sourceRefs: refs,
        })
      } else if (entry.failed) {
        // 配对层已知失败但正文无信号：如实记 unknown 失败，不猜成功也不编退出码。
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.EXIT_CODE,
          value: 'unknown（结果标记失败，正文无退出码）',
          polarity: 'negative',
          sourceRefs: refs,
        })
      }
      const command = commandOfEntry(entry)
      if (command) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.COMMAND,
          value: command,
          polarity: 'positive',
          sourceRefs: refs,
        })
      }
      const testSummary = parseTestSummary(entry.text)
      if (testSummary) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.TEST_SUMMARY,
          value: testSummary.summary,
          polarity: testSummary.failed > 0 ? 'negative' : 'positive',
          sourceRefs: refs,
        })
      }
      const errorSignature = entry.failed ? parseErrorSignature(entry.text) : null
      if (errorSignature) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.ERROR_SIGNATURE,
          value: errorSignature,
          polarity: 'negative',
          sourceRefs: refs,
        })
      }
      for (const version of parseVersionTokens(entry.text)) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.VERSION,
          value: version,
          polarity: 'positive',
          sourceRefs: refs,
        })
      }
      if (!signal && !testSummary && !errorSignature && !command) {
        pushAtom(atoms, {
          scope,
          entity,
          attribute: ATOM_ATTRIBUTES.EXCERPT,
          value: conservativeExcerpt(entry.text),
          polarity: entry.failed ? 'negative' : 'positive',
          sourceRefs: refs,
        })
      }
    })
    return atoms
  }
  // S1：assistant 正文先提结论行（claim 原子，默认 unverified），再走保守摘录。
  // claim 只从 assistant.text 跨度提取——用户消息/工具结果里的「已完成」不是
  // 助手结论（工具侧由 exit-code/test-summary 原子覆盖，用户侧是外部陈述）。
  const assistantClaims = member.spanKind === SPAN_KINDS.ASSISTANT_TEXT
    ? extractClaims(member.body)
    : []
  for (const claim of assistantClaims) {
    pushAtom(atoms, {
      scope,
      entity: 'assistant',
      attribute: ATOM_ATTRIBUTES.CLAIM,
      value: claim.value,
      polarity: claim.polarity,
      qualifier: claim.polarity === 'conditional' || claim.polarity === 'cited' ? claim.polarity : null,
      verified: false,
      sourceRefs: [baseRef(null)],
    })
  }
  // 普通历史段：整段保守摘录（span 拆行后逐段提一行摘录）。
  const parsedSpan = parseSpanBody(member.body)
  const label = member.spanKind ?? 'span'
  if (parsedSpan.ok) {
    for (const span of parsedSpan.spans) {
      pushAtom(atoms, {
        scope,
        entity: label + ':' + span.seq,
        attribute: ATOM_ATTRIBUTES.SPAN_EXCERPT,
        value: conservativeExcerpt(span.text),
        polarity: 'positive',
        pluginAuthored: member.pluginAuthored,
        sourceRefs: [baseRef(null)],
      })
    }
  } else {
    pushAtom(atoms, {
      scope,
      entity: label,
      attribute: ATOM_ATTRIBUTES.SPAN_EXCERPT,
      value: conservativeExcerpt(member.body),
      polarity: member.failed ? 'negative' : 'positive',
      pluginAuthored: member.pluginAuthored,
      sourceRefs: [baseRef(null)],
    })
  }
  return atoms
}

function entityOfEntry(entry) {
  const locator = extractCallLocator({
    arguments: typeof entry?.arguments === 'string' ? entry.arguments : '',
  })
  return typeof locator === 'string' && locator.length > 0 ? locator : null
}

function commandOfEntry(entry) {
  const raw = typeof entry?.arguments === 'string' ? entry.arguments : ''
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim()) return clipExcerpt(value, EXCERPT_LINE_MAX_CHARS)
        if (Array.isArray(value)) return clipExcerpt(value.join(' '), EXCERPT_LINE_MAX_CHARS)
      }
    }
  } catch {
    // 参数不是合法 JSON：不是 command 形态，交给 entity/摘录路径。
  }
  return null
}

// ---------------------------------------------------------------- 事实去重

function firstSeqOf(fact) {
  let min = Number.POSITIVE_INFINITY
  for (const ref of fact.sourceRefs) {
    if (Number.isFinite(ref?.seq)) min = Math.min(min, ref.seq)
  }
  return Number.isFinite(min) ? min : Number.POSITIVE_INFINITY
}

function mergeRefs(target, refs) {
  const seen = new Set(target.map((ref) => ref.recordId + '|' + ref.callId + '|' + ref.seq))
  for (const ref of refs) {
    const id = ref.recordId + '|' + ref.callId + '|' + ref.seq
    if (!seen.has(id)) {
      seen.add(id)
      target.push(ref)
    }
  }
}

/**
 * 完整事实去重（P3-2）：
 * - 同键原子合并为一个事实（sourceRefs 并集去重）——同输出的两次执行保留
 *   两个事件身份（两个 sourceRef）；
 * - 同家族（scope/entity/attribute/qualifier 相同）但值或极性不同的多个事实：
 *   按 seq 排序后极性一致 → 后者标记 relation='correction'（supersedes 前者），
 *   极性翻转或交错 → 全部标记 relation='conflict'；
 * - 更正/冲突/否定事实标 required（预算覆盖选择的必选集）。
 */
export function mergeFacts(atoms) {
  const byKey = new Map()
  for (const atom of atoms) {
    const existing = byKey.get(atom.key)
    if (!existing) {
      byKey.set(atom.key, {
        kind: 'fact',
        key: atom.key,
        familyKey: familyKeyOf(atom),
        scope: atom.scope,
        entity: atom.entity,
        attribute: atom.attribute,
        value: atom.value,
        polarity: atom.polarity,
        qualifier: atom.qualifier,
        sourceRefs: [...atom.sourceRefs],
        ...(atom.pluginAuthored === true ? { pluginAuthored: true } : {}),
        // S1：claim 原子的 unverified 标记随事实透传（claim 去重合并不等于验证）。
        ...(atom.verified === false ? { verified: false } : {}),
        relation: null,
        supersedes: [],
        required: atom.polarity === 'negative',
      })
    } else {
      mergeRefs(existing.sourceRefs, atom.sourceRefs)
      if (atom.pluginAuthored === true) existing.pluginAuthored = true
    }
  }
  const families = new Map()
  for (const fact of byKey.values()) {
    const list = families.get(fact.familyKey) ?? []
    list.push(fact)
    families.set(fact.familyKey, list)
  }
  for (const facts of families.values()) {
    if (facts.length < 2) continue
    facts.sort((a, b) => firstSeqOf(a) - firstSeqOf(b) || a.key.localeCompare(b.key))
    const polarities = new Set(facts.map((fact) => fact.polarity))
    const relation = polarities.size > 1 ? 'conflict' : 'correction'
    for (const [index, fact] of facts.entries()) {
      fact.relation = relation
      fact.required = true
      if (relation === 'correction' && index > 0) {
        fact.supersedes = [facts[index - 1].key]
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => firstSeqOf(a) - firstSeqOf(b) || a.key.localeCompare(b.key),
  )
}

// ---------------------------------------------------------------- 分桶与近似归组

function tokensOf(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[\s/:;,.\-()\[\]{}"']+/)
      .filter((token) => token.length > 1),
  )
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const token of a) if (b.has(token)) hit += 1
  return hit / (a.size + b.size - hit)
}

/** 分桶键：session→phase→artifact→kind（P3-3 的桶维度）。 */
export function bucketOf(fact) {
  return [fact.scope, fact.entity, ATTRIBUTE_FAMILY[fact.attribute] ?? fact.attribute].join('|')
}

/**
 * 先分桶再近似归组（P3-3）。
 *
 * 桶内先按事实键精确归组（mergeFacts 已完成同键合并，这里处理跨键近似）；
 * 近似比较只做 Jaccard ≥ 阈值的候选组织，相似度**不裁定事实对错**——数值/否定/
 * 版本差异的事实即便高相似也不合并（它们键不同，只在「候选组」里相邻呈现）。
 * 候选对数封顶 GROUP_MAX_CANDIDATE_PAIRS；单桶超 MAX_BUCKET_SIZE 时退化为
 * 与最近 COMPARE_WINDOW 个代表比较。截断如实上报。
 */
export function groupAtoms(facts) {
  const buckets = new Map()
  for (const fact of facts) {
    const bucketKey = bucketOf(fact)
    const list = buckets.get(bucketKey) ?? []
    list.push(fact)
    buckets.set(bucketKey, list)
  }
  const groups = []
  let pairsCompared = 0
  let truncated = false
  for (const [bucketKey, bucketFacts] of buckets) {
    // owner: factKey -> 所在组；live: 本桶未被合并掉的组。近似命中把候选的组
    // 并进当前事实的组（并查式），保证组间互斥——一个键只出现在一个组里。
    const owner = new Map()
    const live = new Set()
    for (const [index, fact] of bucketFacts.entries()) {
      const group = { bucketKey, keys: [fact.key], similarity: null }
      owner.set(fact.key, group)
      live.add(group)
      if (index >= MAX_BUCKET_SIZE) {
        truncated = true
        continue
      }
      const candidates = bucketFacts.slice(Math.max(0, index - COMPARE_WINDOW), index)
      const factTokens = tokensOf(fact.value + ' ' + fact.entity)
      for (const candidate of candidates) {
        const candidateGroup = owner.get(candidate.key)
        if (!candidateGroup) continue
        if (pairsCompared >= GROUP_MAX_CANDIDATE_PAIRS) {
          truncated = true
          break
        }
        pairsCompared += 1
        const similarity = jaccard(factTokens, tokensOf(candidate.value + ' ' + candidate.entity))
        if (similarity < GROUP_SIMILARITY_THRESHOLD) continue
        if (candidateGroup !== group) {
          for (const key of candidateGroup.keys) {
            if (!group.keys.includes(key)) group.keys.push(key)
            owner.set(key, group)
          }
          live.delete(candidateGroup)
        }
        const rounded = Math.round(similarity * 100) / 100
        if (group.similarity === null || rounded > group.similarity) {
          group.similarity = rounded
        }
      }
    }
    for (const group of live) groups.push(group)
  }
  return {
    groups: groups.sort(
      (a, b) => a.bucketKey.localeCompare(b.bucketKey) || a.keys[0].localeCompare(b.keys[0]),
    ),
    pairsCompared,
    truncated,
  }
}
