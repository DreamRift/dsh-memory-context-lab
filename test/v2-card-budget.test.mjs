/**
 * 卡片预算与去重测试（审计 P1-4 / P2-5(d)(e)）。
 *
 * 这里要证明的是三件事，而不是声称：
 * - 硬前缀里含**每步都会变的 seq 引用**（未曝光结果、最小依赖集、未闭合配对），
 *   拿「逐字节硬前缀哈希」当去重键等于没有去重：200 步 200 张卡，卡片只增不减；
 *   语义键（先把 seq 引用归一化成 `seq:#` 再哈希）才能让「语义没变」的步不重复注入。
 * - 去重账本是**有界集合**（不是「只跟上一次比」）：键回到某个更早的值也不会重复注入，
 *   账本长度不超过上限。
 * - 卡片形状的注入消息（`source.kind = 包名 / form = working-set`）是归档候选，
 *   而真实人类请求被保护为「最新人类请求」。
 *
 * 全部用确定性夹具：不落库、不碰真实会话与正式灵枢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  CARD_DELTA_HEADER,
  CARD_SEMANTIC_VERSION,
  WORKING_SET_DEFAULTS,
  WORKING_SET_DEDUP_HISTORY_LIMIT,
  WORKING_SET_FULL_REFRESH_EVERY,
  buildWorkingState,
  decideWorkingSetInjection,
  hardPortionOfCard,
  normalizeVolatileRefs,
  renderWorkingSetInjection,
  shouldInjectFullWorkingStateCard,
  workingSetDedupKeyOf,
  workingStateCardDelta,
} from '../src/v2/working-state.mjs'
import { estimateTokensOf } from '../src/v2/budget.mjs'
import { SPAN_KINDS, collectHistoryCandidates } from '../src/v2/history.mjs'
import { PACKAGE_NAME, isHumanAuthoredMessage, isPluginAuthoredMessage } from '../src/core.mjs'

const NOW = 1_700_000_000_000
const SESSION_ID = 'card00000000000000000001'
const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 第 step 步的活动面。
 *
 * 人类请求固定在 seq 1；callId / 工具名 / 正文全部固定，**只有 seq 整体后移**——
 * 这正是审计 P1-4 描述的场景：每步变的只是硬前缀里那些 seq 引用。
 *
 * 布局（每步）：人类请求 → 已配对调用 → 未配对调用（最后一次助手决策）→ 结果。
 * 结果落在最后一次助手决策之后 = 未曝光结果；它同时闭合第一个调用。
 */
function stepFixture(step) {
  const base = 100 + step * 10
  // callId 必须随步唯一（真实宿主的 callId 本来就唯一）：Y-32 后卡片不再印 seq:N，
  // 跨步恒定的 callId 会让卡片逐字节相同，「每步哈希都变」的对照前提失效。
  const closedId = `call_closed_step${step}`
  const openId = `call_open_step${step}`
  const events = new Map()
  events.set(1, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '把状态卡做成有界常驻的，别每步都插一张。' }] },
  })
  events.set(base, {
    type: 'assistant/message',
    data: { turn: 0, step: 0, message: { id: 'a1', content: [{ type: 'tool-call', id: closedId, name: 'read' }] } },
  })
  events.set(base + 1, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: 'b1', content: [{ type: 'tool-call', id: openId, name: 'grep' }] } },
  })
  events.set(base + 2, {
    type: 'tool/result',
    data: { message: { id: 'r1', toolCallId: closedId, content: [{ type: 'text', text: `output ${'x'.repeat(160)}` }] } },
  })
  return {
    surfaceNodes: [1, base, base + 1, base + 2],
    eventAt: (seq) => events.get(seq) ?? null,
  }
}

function stateForStep(step, overrides = {}) {
  const fixture = stepFixture(step)
  return buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: fixture.surfaceNodes,
    eventAt: fixture.eventAt,
    openCalls: [],
    lastAssistantSeq: null,
    now: NOW,
    // 软段夹具：进度行已随 Y-31 移交硬段（本夹具的结果未曝光），claims 是有生产方
    // 的软内容来源；0.13.2-beta.8（Q4）起 constraints 入参已摘除。
    claims: [{ value: '示例结论：状态卡按语义键去重', polarity: 'positive', recordRef: 'r0' }],
    ...overrides,
  })
}

/** count 个「调用 + 结果」的确定性活动面；返回调用所在的 seq，便于断言保留了哪些。 */
function operationsFixture(count) {
  const events = new Map()
  const surfaceNodes = [1]
  const callSeqs = []
  events.set(1, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: `跑 ${count} 步。` }] },
  })
  let seq = 2
  for (let index = 0; index < count; index += 1) {
    events.set(seq, {
      type: 'assistant/message',
      data: { turn: index, step: index, message: { id: `a${index}`, content: [{ type: 'tool-call', id: `call_${index}`, name: 'read' }] } },
    })
    surfaceNodes.push(seq)
    callSeqs.push(seq)
    seq += 1
    events.set(seq, {
      type: 'tool/result',
      data: { message: { id: `r${index}`, toolCallId: `call_${index}`, content: [{ type: 'text', text: `output-${index} ${'x'.repeat(80)}` }] } },
    })
    surfaceNodes.push(seq)
    seq += 1
  }
  return { surfaceNodes, eventAt: (target) => events.get(target) ?? null, callSeqs }
}

test('Case A：200 步只有 seq 引用在变时，生产去重只注入 1 张卡，卡片文本总量不随步数增长', () => {
  const steps = 200
  let semanticKeys = []
  let naiveKeys = []
  let semanticInjections = 0
  let naiveInjections = 0
  let semanticBytes = 0
  let semanticTokens = 0
  let naiveBytes = 0
  let naiveTokens = 0
  let maxCardBytes = 0
  let maxCardTokens = 0
  let firstKey = null
  const semanticInjectedAt = []

  for (let step = 0; step < steps; step += 1) {
    const state = stateForStep(step)
    const card = renderWorkingSetInjection(state, { budgetTokens: 4000 })
    const bytes = Buffer.byteLength(card.text, 'utf8')
    maxCardBytes = Math.max(maxCardBytes, bytes)
    maxCardTokens = Math.max(maxCardTokens, card.usedTokens)

    // 生产裁决：语义键（index.mjs 的注入钩子走的就是这个函数 + 这个键）。
    const semantic = decideWorkingSetInjection({
      dedupKey: card.prefix.dedupKey,
      sessionId: SESSION_ID,
      injectedKeys: semanticKeys,
    })
    firstKey = firstKey ?? semantic.dedupKey
    if (semantic.inject) {
      semanticInjections += 1
      semanticBytes += bytes
      semanticTokens += card.usedTokens
      semanticKeys = semantic.keys
      semanticInjectedAt.push(step)
    }

    // 对照组 = 修复前的口径：逐字节硬前缀哈希。它每步都不同 → 每步一张卡。
    const naive = decideWorkingSetInjection({
      dedupKey: card.prefix.hash,
      sessionId: SESSION_ID,
      injectedKeys: naiveKeys,
    })
    if (naive.inject) {
      naiveInjections += 1
      naiveBytes += bytes
      naiveTokens += card.usedTokens
      naiveKeys = naive.keys
    }
  }

  console.log('[Case A] 200 步累计注入：'
    + `语义键 ${semanticInjections} 张 / ${semanticBytes} 字节 / ≈${semanticTokens} token（注入于第 ${semanticInjectedAt.join('、')} 步）；`
    + `逐字节哈希（修复前口径）${naiveInjections} 张 / ${naiveBytes} 字节 / ≈${naiveTokens} token；`
    + `单卡最大 ${maxCardBytes} 字节 / ≈${maxCardTokens} token；`
    + `语义键=${String(firstKey).slice(0, 24)}…`)

  // 修复前口径：每步一张卡（这就是「90 次注入 = 90 张卡」的机制）。
  assert.equal(naiveInjections, steps, '逐字节硬前缀哈希每步都变，说明它不能当去重键')
  // 修复后：语义没变 → 只注入一次，远小于小常数上限。
  assert.ok(semanticInjections <= 3, `语义去重必须把小常数上限内的卡数压住，实际 ${semanticInjections}`)
  assert.equal(semanticInjections, 1, '只有 seq 引用在变时，应当只注入一次')
  assert.equal(semanticKeys.length, 1, '语义键在 200 步里必须是同一个')

  // 文本总量有显式上界：不是「随步数增长」，而是「与单卡同量级」。
  assert.ok(semanticBytes <= maxCardBytes * 3, `注入总量 ${semanticBytes} 不得超过单卡上限 ${maxCardBytes} 的 3 倍`)
  assert.ok(semanticBytes < 20_000, `200 步的注入总量必须有界，实际 ${semanticBytes} 字节`)
  assert.ok(semanticTokens < 6_000, `200 步的注入总量必须有界，实际 ≈${semanticTokens} token`)
  assert.ok(naiveBytes > semanticBytes * 50, '修复前口径的累计字节数应当远大于语义去重')

  // 接线断言：去重与注入形态裁决收在引擎（runtime.mjs）里，index.mjs 的钩子只
  // 负责把返回的文本挂上稳定 id 追加——「裁决为跳过时不推进注入状态」只有引擎
  // 能保证。旧 Map 比较与 index.mjs 侧裁决必须已删除。
  // 0.13.1 P4b：注入裁决与卡组折叠已整体迁到 runtime-card.mjs，因此扫描面按
  // 「runtime 侧 + card 域」合并——断言的是「生产路径确实调用了这三个裁决」，
  // 不是「代码必须长在某个文件名里」。
  const runtimeSource = [
    readFileSync(path.join(PLUGIN_DIR, 'src', 'v2', 'runtime.mjs'), 'utf8'),
    readFileSync(path.join(PLUGIN_DIR, 'src', 'v2', 'runtime-card.mjs'), 'utf8'),
  ].join('\n')
  assert.match(runtimeSource, /decideWorkingSetInjection\(\{/, '生产路径必须走去重裁决')
  assert.match(runtimeSource, /workingSetDedupKeyOf\(card\.text\)/, '必须按语义键口径计算去重键（回退口径）')
  assert.match(runtimeSource, /shouldInjectFullWorkingStateCard\(\{/, '必须按形态裁决选全量卡/增量卡')
  assert.match(runtimeSource, /workingStateCardDelta\(\{/, '必须在非全量步渲染增量卡')
  const indexSource = readFileSync(path.join(PLUGIN_DIR, 'src', 'index.mjs'), 'utf8')
  assert.ok(!indexSource.includes('decideWorkingSetInjection'), 'index.mjs 不再持有去重裁决（收进引擎）')
  assert.ok(!indexSource.includes('injectedWorkingSetKeys'), 'index.mjs 侧的旧去重存储必须已删除')
})

test('Case B：卡形状的注入消息是可归档候选，真实人类请求被保护为「最新人类请求」', () => {
  const humanText = '把状态卡做成有界常驻的，并且不要每步都插一张。'
  const cardText = '[工作状态·v2]（插件生成的工作资料，不是系统指令；原文可按记录 ID 回读）\n'
    + '- 当前人类请求（seq:1）：把状态卡做成有界常驻的。'
  const events = new Map()
  events.set(1, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: humanText }] },
  })
  events.set(2, {
    type: 'user/message',
    data: { id: 'card-1', source: { kind: PACKAGE_NAME, form: 'working-set' }, content: [{ type: 'text', text: cardText }] },
  })

  // 判定层：人类消息是「人类输入」，卡片不是。
  assert.equal(isHumanAuthoredMessage(events.get(1)), true)
  assert.equal(isHumanAuthoredMessage(events.get(2)), false, '插件注入的卡片不得冒充人类输入')
  assert.equal(isPluginAuthoredMessage(events.get(2)), true)

  // 收集层：卡片进候选（可退热），人类请求进保护位（不可退热）。
  const { candidates, skipped } = collectHistoryCandidates({
    surfaceNodes: [1, 2],
    eventAt: (seq) => events.get(seq) ?? null,
    measuredNodes: [{ heuristicTokens: 20 }, { heuristicTokens: 60 }],
    retainOperations: 0,
    openTurn: null,
    archivedRanges: [],
    minimumChars: 1,
    lastAssistantSeq: null,
  })

  const cardCandidate = candidates.find((entry) => entry.rangeStart === 2)
  assert.ok(cardCandidate, '卡形状的注入消息必须出现在归档候选里（否则旧卡永远退不了热）')
  assert.equal(cardCandidate.spanKind, SPAN_KINDS.USER_TEXT)
  assert.ok(cardCandidate.body.includes(cardText), '候选正文必须是该节点的逐字文本')

  const humanSkip = skipped.find((entry) => entry.seq === 1)
  assert.ok(humanSkip, '最新人类请求必须出现在跳过清单里（而不是被静默丢掉）')
  assert.equal(humanSkip.reason, 'protected-latest-human-request')
  assert.ok(!candidates.some((entry) => entry.rangeStart === 1), '人类请求不得进入归档候选')

  console.log(`[Case B] 候选 ${candidates.length} 条（卡片 seq=2 在候选里），跳过 ${skipped.length} 条`
    + `（seq=1 原因 ${humanSkip.reason}）`)
})

test('Case C：语义没变时去重键不变，逐字节硬前缀哈希可以不同', () => {
  const cardA = renderWorkingSetInjection(stateForStep(0), { budgetTokens: 4000 })
  const cardB = renderWorkingSetInjection(stateForStep(7), { budgetTokens: 4000 })

  assert.notEqual(cardA.prefix.hash, cardB.prefix.hash, 'seq 引用变了，逐字节哈希必然不同')
  assert.equal(cardA.prefix.dedupKey, cardB.prefix.dedupKey, '语义没变 → 去重键必须相同')
  assert.ok(cardA.prefix.dedupKey.startsWith(`ws-card:v${CARD_SEMANTIC_VERSION}:`))
  assert.notEqual(cardA.prefix.dedupKey, cardA.prefix.hash, '去重键与逐字节哈希是两个不同的口径')

  // chars / tokenEstimate 仍然描述**真实渲染**的硬前缀，不因为归一化而失真。
  const hardPortion = hardPortionOfCard(cardA.text)
  assert.equal(cardA.prefix.chars, hardPortion.length)
  assert.equal(cardA.prefix.tokenEstimate, estimateTokensOf(hardPortion))
  assert.equal(cardA.prefix.dedupKey, workingSetDedupKeyOf(cardA.text), '键必须能从卡片文本按同一口径重算')

  // 语义真变了 → 键必须变：硬前缀多一段「本步可回读」（readback 是硬段生产方；
  // 0.13.2-beta.8（Q4）起 constraints 入参已摘除，改用有生产方的 readback）。
  const cardC = renderWorkingSetInjection(stateForStep(0, {
    readback: [{ recordId: 't00000001-r0999', tools: ['read'], range: { start: 1, end: 2 }, locator: '位置说明', tokens: 5 }],
  }), { budgetTokens: 4000 })
  assert.notEqual(cardC.prefix.dedupKey, cardA.prefix.dedupKey, '硬前缀内容变了，去重键必须变')

  // 语义真变了 → 键必须变：多一个未闭合配对（条数变化，不是 seq 号变化）。
  const cardD = renderWorkingSetInjection(stateForStep(0, {
    openCalls: [{ callId: 'ledger-1', callRecordId: 't00000001-r0000', callSeq: 1 }],
  }), { budgetTokens: 4000 })
  assert.notEqual(cardD.prefix.dedupKey, cardA.prefix.dedupKey, '保护集条数变了，去重键必须变')

  console.log(`[Case C] 语义键 ${cardA.prefix.dedupKey.slice(0, 30)}…；`
    + `seq 变化后哈希 ${cardA.prefix.hash.slice(0, 18)}… ≠ ${cardB.prefix.hash.slice(0, 18)}… 而键相同`)
})

test('Case C 补充：任何预算形态下，从卡片文本重算的键都等于引擎给的键（注入钩子的回退口径）', () => {
  const state = stateForStep(3)
  for (const budgetTokens of [0, 1, 200, 1200, 8000, Number.NaN]) {
    const card = renderWorkingSetInjection(state, { budgetTokens })
    assert.equal(card.prefix.dedupKey, workingSetDedupKeyOf(card.text),
      `预算 ${budgetTokens} 下重算键必须一致（含硬溢出页脚与丢弃页脚）`)
    // chars 永远描述真实硬前缀，与预算无关。
    assert.equal(card.prefix.chars, hardPortionOfCard(card.text).length)
  }
  // 硬溢出时卡片尾部带告警页脚，切分必须把它排除掉。
  const overflowCard = renderWorkingSetInjection(state, { budgetTokens: 0 })
  assert.equal(overflowCard.hardOverflow, true)
  assert.ok(overflowCard.text.includes('⚠ 硬保护内容'))
  assert.ok(!hardPortionOfCard(overflowCard.text).includes('⚠ 硬保护内容'))
})

test('归一化只吃掉 seq 引用，卡片里出现过的形态全覆盖，别的字段一字不动', () => {
  for (const form of ['seq:833', '（seq:609）', 'seq 12–15', 'seq 12-15', 'seq 12 - 15', 'seq：833', 'seq 12']) {
    const normalized = normalizeVolatileRefs(form)
    assert.ok(normalized.includes('seq:#'), `${form} 必须被归一化成 seq:#`)
    assert.ok(!/\d/.test(normalized), `${form} 归一化后不得残留数字：${normalized}`)
  }
  // callId 也是每步都变的引用：不归一化它，「未曝光结果」行会让整卡每步都换键。
  // 真实 callId 形如 call_00_1qr4pvFCLjY2b2chF6JH5631（段间是下划线，不是连字符）。
  const callLine = '- 未曝光结果 seq:833（callId call_00_1qr4pvFCLjY2b2chF6JH5631，依据 last-assistant-decision）'
  const callNormalized = normalizeVolatileRefs(callLine)
  assert.ok(callNormalized.includes('call:#'), `callId 必须被归一化成 call:#：${callNormalized}`)
  assert.ok(!/call_[0-9A-Za-z]/.test(callNormalized), `归一化后不得残留 callId：${callNormalized}`)
  // 同一行只换 seq 与 callId 时，语义键必须稳定；换掉别的内容则必须变。
  const callLineOther = callLine.replace('call_00_1qr4pvFCLjY2b2chF6JH5631', 'call_01_ZZZZZZZZZZZZZZZZZZZZ99999').replace('seq:833', 'seq:1024')
  assert.equal(normalizeVolatileRefs(callLineOther), callNormalized, '只有 seq/callId 变化时语义键必须不变')
  assert.notEqual(normalizeVolatileRefs(callLine.replace('未曝光结果', '在途动作')), callNormalized, '类目变化必须改变语义键')
  // 记录 ID、普通数字、含 seq 子串的单词都不许被误伤。
  assert.equal(normalizeVolatileRefs('t00000001-r0009'), 't00000001-r0009')
  assert.equal(normalizeVolatileRefs('consequence 12-15'), 'consequence 12-15')
  assert.equal(normalizeVolatileRefs('最多 12 条'), '最多 12 条')
  assert.equal(normalizeVolatileRefs('call_short'), 'call_short', '短 call 串不是 callId，不得误伤')
  assert.equal(normalizeVolatileRefs('called_back_into_the_loop'), 'called_back_into_the_loop', '普通英文词不得误伤')
  // 整卡切硬前缀：软段与页脚不进语义键。
  const card = renderWorkingSetInjection(stateForStep(0), { budgetTokens: 4000 })
  const hardPortion = hardPortionOfCard(card.text)
  assert.ok(hardPortion.startsWith('[工作状态·v2]'))
  assert.ok(!hardPortion.includes('■ 软保留'), '软保留段不得进硬前缀')
  assert.ok(!hardPortion.includes('因预算丢弃'), '丢弃页脚不得进硬前缀')
  assert.ok(card.text.length > hardPortion.length, '这张卡确实带软内容，切分才有意义')
})

test('去重账本是有界集合：键回到更早的值不重复注入，账本不超过上限', () => {
  const keyA = `ws-card:v${CARD_SEMANTIC_VERSION}:aaa`
  const keyB = `ws-card:v${CARD_SEMANTIC_VERSION}:bbb`
  let keys = []

  let verdict = decideWorkingSetInjection({ dedupKey: keyA, sessionId: SESSION_ID, injectedKeys: keys })
  assert.equal(verdict.inject, true)
  assert.equal(verdict.reason, 'new-key')
  keys = verdict.keys

  verdict = decideWorkingSetInjection({ dedupKey: keyB, sessionId: SESSION_ID, injectedKeys: keys })
  assert.equal(verdict.inject, true)
  keys = verdict.keys

  verdict = decideWorkingSetInjection({ dedupKey: keyA, sessionId: SESSION_ID, injectedKeys: keys })
  assert.equal(verdict.inject, false, '键回到更早的值时不得重新注入（这正是「只比上一次」的漏洞）')
  assert.equal(verdict.reason, 'already-injected')

  for (let index = 0; index < WORKING_SET_DEDUP_HISTORY_LIMIT + 5; index += 1) {
    keys = decideWorkingSetInjection({
      dedupKey: `ws-card:v${CARD_SEMANTIC_VERSION}:k${index}`,
      sessionId: SESSION_ID,
      injectedKeys: keys,
    }).keys
  }
  assert.ok(keys.length <= WORKING_SET_DEDUP_HISTORY_LIMIT, `账本必须有界，实际 ${keys.length}`)
  assert.equal(keys.length, WORKING_SET_DEDUP_HISTORY_LIMIT)

  // 拿不到会话键：没有可去重的范围 → 照常注入，且不记账（原行为）。
  const noSession = decideWorkingSetInjection({ dedupKey: keyA, sessionId: null, injectedKeys: [keyA] })
  assert.equal(noSession.inject, true)
  assert.equal(noSession.reason, 'no-session-or-key')
  assert.deepEqual(noSession.keys, [keyA])

  console.log(`[去重账本] 键回到更早的值 → 不再注入；账本上限 ${WORKING_SET_DEDUP_HISTORY_LIMIT}，`
    + `灌入 ${WORKING_SET_DEDUP_HISTORY_LIMIT + 7} 个键后长度 ${keys.length}`)
})

test('P2-5(d)：进度保留最新若干条（旧条目先退役），并如实报未展开条数', () => {
  const count = 30
  const fixture = operationsFixture(count)
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: fixture.surfaceNodes,
    eventAt: fixture.eventAt,
    // Y-31（beta.8）后未曝光结果不进进度：把判定阈值抬到最后一条结果之后，
    // 全部结果视为已曝光（本测试主题是「配额取舍方向」，不被曝光口径干扰）。
    lastAssistantSeq: fixture.callSeqs.at(-1) + 1,
    now: NOW,
  })
  const cap = WORKING_SET_DEFAULTS.maxProgressItems
  assert.equal(state.progressCount, count)
  assert.equal(state.progress.length, cap)

  const newestRef = `seq:${fixture.callSeqs.at(-1)}`
  const oldestRef = `seq:${fixture.callSeqs[0]}`
  assert.equal(state.progress.at(-1).itemId, newestRef, '最新一条进度必须在（旧实现会把最新的丢掉）')
  assert.ok(!state.progress.some((item) => item.itemId === oldestRef), '最早的进度应当先退役')

  const card = renderWorkingSetInjection(state, { budgetTokens: 20_000 })
  // Y-32 后进度行不印 itemId 本体，印可执行句柄：本测试无 recordIdsForSeq 映射，
  // 句柄回落 callId 形态——最新一条 = call_{count-1}，最旧 = call_0。
  const newestCallId = `call_${count - 1}`
  const oldestCallId = 'call_0'
  assert.ok(card.text.includes(`record_ids=["${newestCallId}"]`), '卡片必须展示最新进度（可执行句柄）')
  assert.ok(!card.text.includes(`record_ids=["${oldestCallId}"]`), '卡片不该还停在最早的进度上')
  assert.ok(card.text.includes(`另有 ${count - cap} 条进度未展开`), '被丢掉的条数必须如实报告')

  console.log(`[P2-5(d)] 进度共 ${state.progressCount} 条，卡片保留最新 ${state.progress.length} 条`
    + `（${state.progress[0].itemId} … ${state.progress.at(-1).itemId}），如实报未展开 ${count - cap} 条`)
})

// 0.13.2-beta.8（Q4）：P2-5(e)（wholeTaskPinned 由保护集推导、整任务 pin 计数）随
// pin 类目整段摘除——「测死代码的用例」不再保留；「不许整体 pin」的边界改由
// test/v2-workingset-wiring.test.mjs 的「类目必须有生产方」守卫承接（pin 无数据源，
// whole-task pin 结构上不可能出现）。

/**
 * 验收标准 ③ 定点验证：把用户原始要求落成可判定夹具。
 *
 * 三条断言分别是：
 *  ① 含 `user/message` 正文的会话里，**非工具跨度**的归档候选数 > 0
 *     （P0-2 之后纯文本跨度按活动面节点数判定：恰好 1 个放行，多节点给
 *      `MULTI_NODE_PLAIN_RANGE`，所以夹具里每条 user 消息必须独占一个活动面节点）；
 *  ② 卡片「当前人类请求」不指向插件自己注入的回执（P0-3 判定层已覆盖，这里从
 *     **候选收集**这一侧再压一次：真实人类请求进保护位、插件消息进候选）；
 *  ③ 连续 N 步之后卡片总量有上界（P1-4 语义去重键 + 有界账本）。
 */
test('定点验证 ①：含 user/message 正文的会话，非工具跨度归档候选 > 0（P0-2 放行口径内）', () => {
  // 每条 user/message 都是「纯文本、无工具调用」的活动面节点，且各自独占——
  // 落在 P0-2 的放行分支上（surfaceNodes 恰好 1 个），不是 multi-node-plain-range。
  const humanTexts = [
    '先读一下 config.json，再说结论。',
    '把刚才那条结论改写成三句话。',
    '最后汇总成表格。',
  ]
  const events = new Map()
  const surfaceNodes = []
  let seq = 1
  const userSeqs = []
  for (const text of humanTexts) {
    events.set(seq, {
      seq,
      type: 'user/message',
      // P0-1：宿主契约下正文在 data.content（不是只有 data.message.content）。
      data: { id: `u${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })
    surfaceNodes.push(seq)
    userSeqs.push(seq)
    seq += 1
  }

  const { candidates, skipped } = collectHistoryCandidates({
    surfaceNodes,
    eventAt: (target) => events.get(target) ?? null,
    measuredNodes: surfaceNodes.map(() => ({ heuristicTokens: 24 })),
    retainOperations: 0,
    openTurn: null,
    archivedRanges: [],
    minimumChars: 1,
    lastAssistantSeq: null,
  })

  assert.ok(candidates.length > 0, `含 user/message 正文的会话必须产生非工具跨度归档候选，实际 ${candidates.length} 条`)
  const plainCandidates = candidates.filter((entry) => entry.spanKind === SPAN_KINDS.USER_TEXT)
  assert.ok(plainCandidates.length > 0, '其中必须有 USER_TEXT 形态的纯文本候选')
  for (const entry of plainCandidates) {
    assert.ok(userSeqs.includes(entry.rangeStart), `候选 seq=${entry.rangeStart} 必须是夹具里的 user 消息`)
    assert.ok(entry.body.includes(humanTexts[userSeqs.indexOf(entry.rangeStart)]), '候选正文必须是该 user 消息的逐字文本')
  }
  // 最新人类请求仍被保护，不进入候选（P0-3 口径在候选收集侧的体现）。
  assert.ok(!candidates.some((entry) => entry.rangeStart === userSeqs.at(-1)), '最新人类请求不得进入归档候选')
  assert.ok(skipped.some((entry) => entry.seq === userSeqs.at(-1)
    && entry.reason === 'protected-latest-human-request'), '最新人类请求必须以该原因进跳过清单')

  console.log(`[定点 ①] ${humanTexts.length} 条 user/message → 候选 ${candidates.length} 条`
    + `（纯文本 ${plainCandidates.length} 条），最新人类请求 seq=${userSeqs.at(-1)} 受保护`)
})

/**
 * F2 遗留复现：并行工具调用共享同一宿主 seq 时，卡片不得出现错位/重复的记录句柄。
 *
 * 事实链（为什么 `idsBySeq(seq)` 不能按「第 n 条」取号）：
 * - 一条 assistant/message 可以同时带 text 块与多个 tool-call 块，它们共享同一个
 *   宿主 seq；v2 ingest 给**每个块**各写一条记录（records.mjs 按块生成 draft），
 *   全部挂在该 seq 的倒排桶里；
 * - 于是 `idsBySeq(seq) = [text 记录, call_a 记录, call_b 记录]`，与「共享该 seq 的
 *   调用序列」错位一位：occurrence=0 拿到 text 块的记录，occurrence=1 拿到 call_a
 *   的记录——**没有一行指向 call_b 自己的正文**，第二行还与第一行指向不同的错位
 *   对象（实测表现：进度/在途行同 ID 不同工具名，或两行同句柄）；
 * - 在途路径（surfaceOpenCalls）此前完全不传 occurrence：两个并行在途调用都取
 *   `ids[0]`，两行同句柄。
 *
 * 期望：按 callId 精确对到自己的记录（pairing 账本语义），映射缺失时才退回
 * `seq:N` / `seq:N+occurrence` 的如实标注。
 */
function parallelFixture() {
  const events = new Map()
  events.set(1, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '并行读两个文件再汇总。' }] },
  })
  events.set(5, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a5',
        content: [
          { type: 'text', text: '同时发起两个读取。' },
          { type: 'tool-call', id: 'call_a', name: 'read' },
          { type: 'tool-call', id: 'call_b', name: 'grep' },
        ],
      },
    },
  })
  events.set(6, {
    type: 'tool/result',
    data: { message: { id: 'r6', toolCallId: 'call_a', content: [{ type: 'text', text: `file-a ${'x'.repeat(120)}` }] } },
  })
  events.set(7, {
    type: 'tool/result',
    data: { message: { id: 'r7', toolCallId: 'call_b', content: [{ type: 'text', text: `file-b ${'y'.repeat(120)}` }] } },
  })
  return { events, surfaceNodes: [1, 5, 6, 7] }
}

test('F2 复现 ①：共享 seq 的并行调用（含 text 块）各自行必须指向自己的记录，不得错位', () => {
  const { events, surfaceNodes } = parallelFixture()
  // ingest 后 seq 5 的倒排桶：text 记录、call_a 记录、call_b 记录（块顺序=ID 序）。
  const bySeq = new Map([[5, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003']]])
  // 配对账本（runtime 经 recordIdsForCallId 注入）：callId → 调用/结果记录 ID。
  const byCallId = new Map([
    ['call_a', { callRecordId: 't00000001-r0002', resultRecordId: 't00000001-r0004' }],
    ['call_b', { callRecordId: 't00000001-r0003', resultRecordId: 't00000001-r0005' }],
  ])
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes,
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    // Y-31（beta.8）：结果在最后助手之后属未曝光、不进进度行；本测试主题是
    // refOf 的精确对位，把阈值抬到结果之后使进度行存在。
    lastAssistantSeq: 99,
    now: NOW,
    recordIdsForSeq: (seq) => bySeq.get(seq) ?? [],
    recordIdsForCallId: (callId) => byCallId.get(callId) ?? null,
  })

  const progressOf = (callId) => state.progress.find((item) => item.callId === callId)
  const a = progressOf('call_a')
  const b = progressOf('call_b')
  assert.ok(a, 'call_a 的进度行必须存在')
  assert.ok(b, 'call_b 的进度行必须存在')
  assert.equal(a.itemId, 't00000001-r0002', 'call_a 的行必须指向 call_a 自己的记录（错位时会拿到 text 块的 r0001）')
  assert.equal(b.itemId, 't00000001-r0003', 'call_b 的行必须指向 call_b 自己的记录（错位时会拿到 call_a 的 r0002）')
  assert.equal(a.itemIdKind, 'record-id')
  assert.equal(b.itemIdKind, 'record-id')
  assert.deepEqual(a.evidenceRefs, ['t00000001-r0004'], 'call_a 的结果句柄指向自己的结果记录')
  assert.deepEqual(b.evidenceRefs, ['t00000001-r0005'], 'call_b 的结果句柄指向自己的结果记录')
  assert.ok(a.itemId !== b.itemId, '两条不同调用的行不得共用同一个记录句柄')

  console.log(`[F2 复现 ①] 并行调用共享 seq=5（含 text 块）：call_a→${a.itemId}，call_b→${b.itemId}`)
})

test('F2 复现 ②：并行在途调用（共享 seq、无结果）不得都指向 ids[0]', () => {
  const events = new Map()
  events.set(1, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '并行发起两个读取。' }] },
  })
  events.set(5, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a5',
        content: [
          { type: 'tool-call', id: 'call_a', name: 'read' },
          { type: 'tool-call', id: 'call_b', name: 'grep' },
        ],
      },
    },
  })
  const bySeq = new Map([[5, ['t00000001-r0001', 't00000001-r0002']]])
  const byCallId = new Map([
    ['call_a', { callRecordId: 't00000001-r0001', resultRecordId: null }],
    ['call_b', { callRecordId: 't00000001-r0002', resultRecordId: null }],
  ])
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: [1, 5],
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    lastAssistantSeq: 99,
    now: NOW,
    recordIdsForSeq: (seq) => bySeq.get(seq) ?? [],
    recordIdsForCallId: (callId) => byCallId.get(callId) ?? null,
  })

  assert.equal(state.openActions.length, 2, '两个并行在途调用都必须出现在在途动作里')
  const [first, second] = state.openActions
  assert.equal(first.recordRef, 't00000001-r0001', 'call_a 的在途句柄指向自己的记录')
  assert.equal(second.recordRef, 't00000001-r0002', 'call_b 的在途句柄必须指向自己的记录（修复前都取 ids[0]）')
  assert.ok(first.recordRef !== second.recordRef, '两个在途调用不得共用同一个记录句柄')

  console.log(`[F2 复现 ②] 并行在途调用：call_a→${first.recordRef}，call_b→${second.recordRef}`)
})

test('F2 兜底：没有 callId 精确映射时，共享 seq 的并行调用退回 host-seq 且按出现次序区分', () => {
  const { events, surfaceNodes } = parallelFixture()
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes,
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    lastAssistantSeq: 99,
    now: NOW,
    recordIdsForSeq: () => [],
  })

  const progressOf = (callId) => state.progress.find((item) => item.callId === callId)
  assert.equal(progressOf('call_a').itemId, 'seq:5')
  assert.equal(progressOf('call_b').itemId, 'seq:5+1')
  assert.equal(progressOf('call_a').itemIdReadable, false)
  assert.equal(progressOf('call_b').itemIdReadable, false)

  console.log('[F2 兜底] 无映射时共享 seq 的两行按出现次序标注：seq:5 与 seq:5+1')
})

test('F2 失败关闭：只有 seq 倒排（多记录）、无 callId 映射时，不得按出现次序猜可读 ID', () => {
  const { events, surfaceNodes } = parallelFixture()
  // seq 5 桶里 3 条记录（text + 两个调用），但没有配对账本可查：occurrence 与记录
  // 序列并不同构，任何「按第 n 条取号」都是猜——猜出来的可读 ID 会把模型引去回读
  // 别人的正文。此时必须退回 host-seq（readable:false），把不可判定如实写进卡片。
  const bySeq = new Map([[5, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003']]])
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes,
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    lastAssistantSeq: 99,
    now: NOW,
    recordIdsForSeq: (seq) => bySeq.get(seq) ?? [],
  })

  const progressOf = (callId) => state.progress.find((item) => item.callId === callId)
  assert.equal(progressOf('call_a').itemId, 'seq:5', '无 callId 对位时第一行退回 host-seq，不得猜 ids[0]')
  assert.equal(progressOf('call_b').itemId, 'seq:5+1', '第二行按出现次序标注')
  assert.equal(progressOf('call_a').itemIdReadable, false, '猜不出的对位不得标成可读 record-id')
  assert.equal(progressOf('call_b').itemIdReadable, false)

  // 单记录桶且第一次出现：无歧义，允许给可读 ID（防误杀对照）。
  const single = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: [1, 8, 9],
    eventAt: (seq) => (seq === 1
      ? { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '读一个文件。' }] } }
      : seq === 8
        ? { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a8', content: [{ type: 'tool-call', id: 'call_only', name: 'read' }] } } }
        : { type: 'tool/result', data: { message: { id: 'r9', toolCallId: 'call_only', content: [{ type: 'text', text: `single ${'x'.repeat(100)}` }] } } }),
    openCalls: [],
    lastAssistantSeq: 99,
    now: NOW,
    recordIdsForSeq: (seq) => (seq === 8 ? ['t00000001-r0009'] : []),
  })
  assert.equal(single.progress[0].itemId, 't00000001-r0009', '单记录桶无歧义时保持可读 record-id')

  console.log('[F2 失败关闭] 多记录桶无 callId 对位 → host-seq 如实标注；单记录桶无歧义 → 仍给可读 ID')
})

// ---------------------------------------------------------------------------
// D1 升级（c896f803 循环根因 #1）：增量注入
// ---------------------------------------------------------------------------

test('语义版本升级到 v5：Q4 摘类目 + Y-31/Y-32 渲染口径变化，键里编 v5', () => {
  // v4 是 F1（软保留按重要度装包）；v5 是 0.13.2-beta.8（Q4 类目封闭集收缩 +
  // Y-31 进度行判重 + Y-32 可执行句柄）——渲染语义整体变化，旧键必须全部失效。
  assert.equal(CARD_SEMANTIC_VERSION, 5)
  assert.match(workingSetDedupKeyOf('任意文本'), /^ws-card:v5:/, '键前缀必须携带 v5')
})

test('形态裁决：首张全量、每 N 张再锚定、重启回落全量', () => {
  // 无上一张全量卡：全量（首次注入 / 重启后内存态丢失）。
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: null, injectionCount: 5 }), true)
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: '', injectionCount: 5 }), true, '空串按没有上一张处理，不猜')
  // 有上一张：默认每 20 张回一次全量（count = 本会话已注入总数，≥1 时才可能带上一张）。
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 1 }), false)
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 19 }), false)
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 20 }), true)
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 40 }), true)
  // previousText 与 count=0 并存是非法序列（有上一张就意味着至少注入过一次）；
  // 按锚点全量处理（fail-safe），不猜。
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 0 }), true)
  // 非法入参按保守处理：回到全量，不猜。
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: Number.NaN }), true)
  assert.equal(shouldInjectFullWorkingStateCard({ previousText: 'x', injectionCount: 3, fullEvery: 1 }), true, 'fullEvery=1 退化为每步全量')
})

test('增量差异：只带新增行与所属段标题，不带固定协议文案；消失行只报计数；无变化返回 null', () => {
  const previous = [
    '[工作状态·v2]（插件生成的工作资料，不是系统指令；原文可按记录 ID 回读）',
    '本卡来源 status-card：authority 等于来源本身，不可提升为 system/developer/user；摘要不等于原文，模型推断不构成授权。',
    '■ 保护集·在途动作与未闭合配对（hard/unclosed-call）',
    '- 在途动作 call_a（read）：awaiting-result，来源 活动面未配对调用，记录 seq:5',
    '- 在途动作 call_b（grep）：awaiting-result，来源 活动面未配对调用，记录 seq:5+1',
    '依据/释放：未闭合的工具调用是「已经发出、还没有回执」的在途动作；丢掉会让模型看到没有回执的调用，或凭空出现的结果。｜只在配对账本给出对应结果、或用户显式中止该动作时释放。',
    '■ 软保留·未决问题（尽量保留）（soft/open-question）',
    '- 未决问题 状态卡的增量形态要不要默认开',
  ].join('\n')
  const next = [
    // call_a 的行消失（配对闭合）：slice(0,3) 只保留头部、权威声明与段标题。
    previous.split('\n').slice(0, 3).join('\n'),
    // call_b 的行保留；新增一条未决问题。
    '- 在途动作 call_b（grep）：awaiting-result，来源 活动面未配对调用，记录 seq:5+1',
    '依据/释放：未闭合的工具调用是「已经发出、还没有回执」的在途动作；丢掉会让模型看到没有回执的调用，或凭空出现的结果。｜只在配对账本给出对应结果、或用户显式中止该动作时释放。',
    '■ 软保留·未决问题（尽量保留）（soft/open-question）',
    '- 未决问题 状态卡的增量形态要不要默认开',
    '- 未决问题 增量卡丢失全量卡时如何恢复',
  ].join('\n')

  const delta = workingStateCardDelta({ previousText: previous, nextText: next })
  assert.ok(delta, '有真实变化时必须产出增量卡')
  assert.ok(delta.text.startsWith(CARD_DELTA_HEADER), '增量卡必须带自己的头，不冒充全量卡')
  assert.ok(delta.text.includes('■ 软保留·未决问题（尽量保留）'), '新增行所属的段标题必须带上（含未变化的标题）')
  assert.ok(delta.text.includes('未决问题 增量卡丢失全量卡时如何恢复'), '新增行必须在')
  assert.ok(!delta.text.includes('未决问题 状态卡的增量形态要不要默认开'), '保留的旧行不得重复注入')
  assert.ok(!delta.text.includes('在途动作 call_b'), '保留的旧行（在途动作）不得重复注入')
  assert.ok(!delta.text.includes('依据/释放：'), '固定协议文案不得随增量卡重复')
  assert.ok(!delta.text.includes('本卡来源 status-card'), '固定权威声明不得随增量卡重复')
  assert.match(delta.text, /已不再列出 1 行/, '消失行只报计数')
  assert.equal(delta.addedLines, 1, '新增行计数只算真实新增（标题不算新增行）')
  assert.equal(delta.removedLines, 1, '消失行计数 = call_a 的那一行')

  // 无变化：null（调用方跳过注入）。
  assert.equal(workingStateCardDelta({ previousText: previous, nextText: previous }), null)
  // 输入不可靠：null（拿不到上一张全量卡就不发增量卡）。
  assert.equal(workingStateCardDelta({ previousText: null, nextText: next }), null)
  assert.equal(workingStateCardDelta({ previousText: previous, nextText: '' }), null)
})

test('增量差异是多集差异：同一行文本在上一张出现 1 次、本张出现 2 次时，多出的那次要注入', () => {
  const line = '- 进度 seq:5 工具 read 状态 result-visible'
  const previous = ['■ 软保留·非必要历史（可丢弃）（soft/non-essential-history）', line].join('\n')
  const next = ['■ 软保留·非必要历史（可丢弃）（soft/non-essential-history）', line, line].join('\n')
  const delta = workingStateCardDelta({ previousText: previous, nextText: next })
  assert.ok(delta, '多集计数增加是真实变化')
  assert.equal(delta.addedLines, 1, '只注入多出的那一次出现')
  const occurrences = delta.text.split('\n').filter((text) => text === line).length
  assert.equal(occurrences, 1, '增量卡里该行恰好出现 1 次（多出的那次），不是两次')
})

test('c896f803 循环形态重放：每步有真实新信息时，全量卡只在锚点注入，其余步是变化行量级的增量卡', () => {
  // 每步新增一次已完成的工具调用，并给它分配稳定的记录 ID（宿主 meter 口径下
  // 卡片会印出可回读的 record-id，这正是实测会话里每步键都不同的原因）。
  // 键每步都变（真实语义变化），但增量卡只装变化行。
  const steps = 60
  const stateFor = (step) => {
    const events = new Map()
    events.set(1, {
      type: 'user/message',
      data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '长任务，每步推进一点。' }] },
    })
    const surfaceNodes = [1]
    const idsBySeq = new Map()
    let seq = 2
    for (let index = 0; index <= step; index += 1) {
      events.set(seq, {
        type: 'assistant/message',
        data: { turn: index, step: index, message: { id: `a${index}`, content: [{ type: 'tool-call', id: `call_${index}`, name: 'read' }] } },
      })
      idsBySeq.set(seq, [`t00000001-r${String(index + 1).padStart(4, '0')}`])
      surfaceNodes.push(seq)
      seq += 1
      events.set(seq, {
        type: 'tool/result',
        data: { message: { id: `r${index}`, toolCallId: `call_${index}`, content: [{ type: 'text', text: `output-${index} ${'x'.repeat(80)}` }] } },
      })
      idsBySeq.set(seq, [`t00000001-r${String(index + 1001).padStart(4, '0')}`])
      surfaceNodes.push(seq)
      seq += 1
    }
    return buildWorkingState({
      sessionId: SESSION_ID,
      surfaceNodes,
      eventAt: (target) => events.get(target) ?? null,
      openCalls: [],
      lastAssistantSeq: seq - 1,
      now: NOW,
      recordIdsForSeq: (target) => idsBySeq.get(target) ?? [],
    })
  }

  // 复刻 runtime.mjs 的注入序列：语义键去重 → 形态裁决 → 增量渲染。
  let keys = []
  let previousFull = null
  let injections = 0
  let fullCount = 0
  let deltaCount = 0
  let injectedTokens = 0
  let fullTokens = 0
  for (let step = 0; step < steps; step += 1) {
    const card = renderWorkingSetInjection(stateFor(step), { budgetTokens: 4000 })
    const verdict = decideWorkingSetInjection({
      dedupKey: card.prefix.dedupKey,
      sessionId: SESSION_ID,
      injectedKeys: keys,
    })
    if (!verdict.inject) continue
    keys = verdict.keys
    const full = shouldInjectFullWorkingStateCard({ previousText: previousFull, injectionCount: injections })
    if (full) {
      fullCount += 1
      fullTokens += card.usedTokens
      injectedTokens += card.usedTokens
      previousFull = card.text
    } else {
      const delta = workingStateCardDelta({ previousText: previousFull, nextText: card.text })
      assert.ok(delta, `第 ${step} 步键变了就必须有增量可注入`)
      assert.ok(delta.text.startsWith(CARD_DELTA_HEADER))
      assert.ok(!delta.text.includes('依据/释放：'), '增量卡不得重复固定协议文案')
      deltaCount += 1
      injectedTokens += estimateTokensOf(delta.text)
    }
    injections += 1
  }

  console.log(`[增量重放] ${steps} 步：全量 ${fullCount} 张（≈${fullTokens} token）+ 增量 ${deltaCount} 张，`
    + `累计注入 ≈${injectedTokens} token；全量口径对照 ≈${fullTokens * steps} token`)

  assert.equal(fullCount, Math.ceil(steps / WORKING_SET_FULL_REFRESH_EVERY), '全量卡只在锚点注入')
  assert.equal(deltaCount, steps - fullCount, '其余步全部是增量卡')
  assert.ok(injectedTokens < fullTokens * steps * 0.25,
    `增量注入累计 ≈${injectedTokens} token 必须显著低于每步全量口径 ≈${fullTokens * steps} token`)
})
