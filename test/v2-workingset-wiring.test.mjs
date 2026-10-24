/**
 * Q4 结构性守卫（0.13.2-beta.8）：**类目必须先有生产方才能进渲染集**。
 *
 * 缺陷来源：修复计划-beta.8 §〇——evidence/pins/inflightJobs/constraints/relations/
 * projection/prefetch/redundantCards/rejectedOptions/openQuestions 十类入参在 src 内
 * 从未有过调用方（恒空），但类目表、配额键、构造器、输出字段陪葬了整套死代码；
 * 其中在途作业段的溢出行还引用了从未定义的变量（jobCap），被「没人传参」掩盖。
 *
 * 本守卫把「不再生」编码成三条可判定断言：
 *  ① buildWorkingState 声明的每个形参，要么被 src 内**全部**调用点实参传入，
 *     要么在显式白名单里附理由——新增「先声明后接线」的形参必红；
 *  ② 反向：调用点不得传入未声明的键（接线到已摘除的类目必红）；
 *  ③ 渲染封闭集（PROTECTION_ORDER / DROP_ORDER）的每个类目，必须能用真实夹具
 *     生产出至少一条条目（动态证明），且静态存在 protectedItem 生产点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  PROTECTION_CLASSES,
  PROTECTION_ORDER,
  RETENTION_CLASSES,
  DROP_ORDER,
  buildWorkingState,
} from '../src/v2/working-state.mjs'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const workingStateSrc = await readFile(path.join(SRC_DIR, 'v2', 'working-state.mjs'), 'utf8')
const runtimeCardSrc = await readFile(path.join(SRC_DIR, 'v2', 'runtime-card.mjs'), 'utf8')

/** 形参是「配置覆盖通道」或「测试注入」等合法的无人传参项，必须在这里附理由。 */
const PARAM_ALLOWLIST = Object.freeze({
  // 配置覆盖通道：设置层演进入口，默认值兜底（Y-28 的逐键合并仍由 limits 承载）。
  limits: '配置覆盖通道，由设置层演进；src 调用点暂不传',
  // 时钟注入：测试与确定性需要；生产语义 = Date.now()。
  now: '时钟注入，测试用；生产默认 Date.now()',
})

/** 从源码文本里取 buildWorkingState 解构签名的形参名（剥离签名体内的注释）。 */
function declaredParamsOf(source) {
  const anchor = 'export function buildWorkingState({'
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, 'buildWorkingState 签名锚点丢失（夹具脱节）')
  const bodyStart = start + anchor.length
  const end = source.indexOf('} = {}) {', bodyStart)
  assert.ok(end > bodyStart, 'buildWorkingState 签名结尾锚点丢失（夹具脱节）')
  const body = source.slice(bodyStart, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.includes('*/') && !line.trim().startsWith('//'))
    .join('\n')
  const names = []
  for (const match of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*(=[^=].*)?,?\s*$/gm)) {
    names.push(match[1])
  }
  assert.ok(names.length > 0, '形参解析失败（夹具脱节）')
  return names
}

/** 从调用点文本里取第一层键（以首个键的缩进为准，避免误吃嵌套对象的键）。 */
function callSiteKeysOf(source, callLabel) {
  const anchor = 'buildWorkingState({'
  let from = 0
  const found = []
  for (;;) {
    const start = source.indexOf(anchor, from)
    if (start < 0) break
    from = start + anchor.length
    // 花括号配对找到对象字面量结尾（调用点无字符串内嵌花括号，失配会显式失败）
    let depth = 1
    let index = from
    while (depth > 0 && index < source.length) {
      const ch = source[index]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      index += 1
    }
    assert.ok(depth === 0, `${callLabel}：buildWorkingState 调用点花括号失配（夹具脱节）`)
    const body = source.slice(from, index - 1)
    const firstKey = body.match(/^\s+([A-Za-z_$][\w$]*)\s*(,|:)/m)
    assert.ok(firstKey, `${callLabel}：调用点没有可识别的键（夹具脱节）`)
    const indent = body.match(/^([ \t]*)[A-Za-z_$][\w$]*\s*(,|:)/m)[1]
    const keyAtSameIndent = new RegExp(`^${indent}([A-Za-z_$][\\w$]*)\\s*(,|:|\\n)`, 'gm')
    const keys = new Set()
    for (const match of body.matchAll(keyAtSameIndent)) keys.add(match[1])
    assert.ok(keys.size > 0, `${callLabel}：调用点键提取为空（夹具脱节）`)
    found.push([...keys])
  }
  return found
}

test('wiring ①：buildWorkingState 每个形参都有至少一个调用点传入，或在白名单里附理由', () => {
  const declared = declaredParamsOf(workingStateSrc)
  const callSites = callSiteKeysOf(runtimeCardSrc, 'runtime-card')
  assert.ok(callSites.length >= 2, `src 内 buildWorkingState 调用点应 ≥2 个，实际 ${callSites.length}（新增调用点必须同样过本守卫）`)
  const problems = []
  for (const name of declared) {
    // 判据是「≥1 个调用点传入」：跨路径可选（如 readback 只在 buildCard 传）是
    // 合法形态；**零**调用点传入且不在白名单 = 未接线类目再生，必红。
    const wired = callSites.some((keys) => keys.includes(name))
    if (!wired && !Object.hasOwn(PARAM_ALLOWLIST, name)) {
      problems.push(`${name}：无任何调用点传入、也不在 PARAM_ALLOWLIST 白名单（先建数据源，再加形参）`)
    }
  }
  assert.deepEqual(problems, [], `存在未接线形参：\n${problems.join('\n')}`)
})

test('wiring ②：调用点不得传入未声明的键（摘除类目不得被悄悄接回）', () => {
  const declared = new Set(declaredParamsOf(workingStateSrc))
  const callSites = callSiteKeysOf(runtimeCardSrc, 'runtime-card')
  const problems = []
  for (const [site, keys] of callSites.entries()) {
    for (const key of keys) {
      if (!declared.has(key)) problems.push(`调用点 ${site + 1} 传入了未声明形参 ${key}`)
    }
  }
  assert.deepEqual(problems, [], `调用点传参超出形参清单：\n${problems.join('\n')}`)
})

test('wiring ③：硬保护与软保留的每个类目都能被真实夹具生产（动态证明）', () => {
  // Y-31 后进度只收「已曝光的完成态」：夹具给两对调用-结果，第一对落在最后助手
  // 之前（曝光 → 进度行）、第二对的结果在最后助手之后（未曝光 → UNEXPOSED_RESULT）。
  const events = new Map()
  const surfaceNodes = []
  let seq = 1
  events.set(seq, { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '把工作集做成有界常驻。' }] } })
  surfaceNodes.push(seq)
  seq += 1
  events.set(seq, { type: 'assistant/message', data: { turn: 0, message: { id: 'a0', content: [{ type: 'tool-call', id: 'call_0', name: 'read' }] } } })
  surfaceNodes.push(seq)
  seq += 1
  events.set(seq, { type: 'tool/result', data: { message: { id: 'r0', toolCallId: 'call_0', content: [{ type: 'text', text: 'out0' }] } } })
  surfaceNodes.push(seq)
  seq += 1
  events.set(seq, { type: 'assistant/message', data: { turn: 1, message: { id: 'a1', content: [{ type: 'tool-call', id: 'call_1', name: 'grep' }] } } })
  const lastAssistant = seq
  surfaceNodes.push(seq)
  seq += 1
  events.set(seq, { type: 'tool/result', data: { message: { id: 'r1', toolCallId: 'call_1', content: [{ type: 'text', text: 'out1' }] } } })
  surfaceNodes.push(seq)
  seq += 1
  const state = buildWorkingState({
    sessionId: 'wiring',
    surfaceNodes,
    eventAt: (target) => events.get(target) ?? null,
    openCalls: [{ callId: 'open_0', callRecordId: 't00000001-r0001', callSeq: 99 }],
    lastAssistantSeq: lastAssistant,
    now: 1_700_000_000_000,
    claims: [{ value: '一条结论', polarity: 'positive', recordRef: 'r1' }],
  })
  const hardClasses = new Set(state.protectedSet.map((item) => item.protectionClass))
  for (const protectionClass of PROTECTION_ORDER) {
    // UNKNOWN_PROTOCOL 是协议位：健康会话里 unknowns 为空是正常态，它的生产点在
    // 「判定不可用」路径——用无助手节点的第二夹具证明（曝光未知）。
    if (protectionClass === PROTECTION_CLASSES.UNKNOWN_PROTOCOL) continue
    assert.ok(hardClasses.has(protectionClass), `硬保护类目 ${protectionClass} 无生产方（夹具生产不出任何条目）`)
  }
  for (const retentionClass of DROP_ORDER) {
    const items = state.retention[retentionClass]
    assert.ok(Array.isArray(items) && items.length > 0, `软保留类目 ${retentionClass} 无生产方（夹具生产不出任何条目）`)
  }
  // UNKNOWN_PROTOCOL 的动态生产证明：表面没有 assistant/message 节点（lastAssistant
  // 从表面推导）时曝光判定不可用，未知条目必须进保护集。
  const unknownEvents = new Map()
  const unknownSurface = [900]
  unknownEvents.set(900, { type: 'user/message', data: { id: 'u9', source: { kind: 'user' }, content: [{ type: 'text', text: '只有请求，还没有任何助手决策。' }] } })
  const unknownState = buildWorkingState({
    sessionId: 'wiring-unknown',
    surfaceNodes: unknownSurface,
    eventAt: (target) => unknownEvents.get(target) ?? null,
    openCalls: [],
    lastAssistantSeq: null,
    now: 1_700_000_000_000,
  })
  assert.ok(
    unknownState.protectedSet.some((item) => item.protectionClass === PROTECTION_CLASSES.UNKNOWN_PROTOCOL),
    'UNKNOWN_PROTOCOL 无生产方：曝光未知未进保护集',
  )
  // 反向：摘除的类目不得残留在任何导出封闭集里。
  for (const dead of ['inflight-job', 'necessary-evidence', 'valid-pin']) {
    assert.ok(!Object.values(PROTECTION_CLASSES).includes(dead), `已摘类目 ${dead} 不得回流入封闭集`)
  }
})

test('wiring ④：静态生产点存在——每个硬保护类目都有 protectionClass 赋值点', () => {
  for (const [key, value] of Object.entries(PROTECTION_CLASSES)) {
    const pattern = new RegExp(`protectionClass:\\s*PROTECTION_CLASSES\\.${key}\\b`)
    assert.ok(pattern.test(workingStateSrc), `类目 ${value}（${key}）没有 protectionClass 生产点`)
  }
})
