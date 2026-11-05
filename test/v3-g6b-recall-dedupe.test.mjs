/**
 * G6b：回注路径上的可见片段去重（候选，默认关闭）。
 *
 * ## 判据
 * - off 路径与 HEAD **逐字节等价**（学 G5 §4 的指纹法：改动前用 HEAD 代码跑同一组固定
 *   输入，把 sha256(JSON.stringify(结果)) 冻成常量；本套件在新代码上重算）；
 * - on 路径只跳过「被证明当前仍可见」或「已遗忘」的片段；unknown 一律注入（R-1），
 *   宿主面未知时明确退化（degraded 可见）；
 * - 判定输入全部来自 visibility 端口（活动面快照），不读日志/确认/租约（合同 §1.2）。
 *
 * ## 反假绿
 * ① 打开开关必须真的改变输出（否则「等价」是因为候选根本没接上）；
 * ② 量具自检：改一个输入字节，指纹必须变。
 *
 * ## 不适用条件
 * 合成 provider + 合成快照；真实宿主面与真实检索未验（证据文件 §未验边界）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createRecall, RECALL_PACK_MAX_CHARS } from '../src/v3/application/recall.mjs'
import { VISIBILITY_LIMITS } from '../src/v3/contracts/visibility.mjs'
import { PLUGIN_SOURCE_KIND, RECEIPT_SOURCE_FORM } from '../src/v3/contracts/sources.mjs'
import { recordFragmentOf, dedupeKeyOf } from '../src/v3/domain/visibility/fragments.mjs'
import { createVisibilityState } from '../src/v3/domain/visibility/state.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const MARK = 'g6bmark'
const SESSION = 'g6b-session'

/**
 * HEAD 指纹表（改动 recall.mjs **之前**用分支 memory-v0150-g1 @ 08345de 抓取；
 * Node v26.12.1 / win32-x64，2026-11-01）。键 = 用例名，值 = sha256(JSON.stringify(结果))。
 *
 * **0.15.1 P2-18 有意重抓 5 项**（default / exclude / capShrink / truncated / turnGate）：
 * 回注尾行原本只给「命令面 /memory-lab read <ID>」（单次 8000 字、**不分页**），
 * 现在改为**先给可分页的 `memory_context_read`**、再给命令面回退入口。
 * 这 5 个是唯一会产生回注正文的场景，其余 6 项（preview0 / turn0 / badPreview /
 * emptySearch / indexAbsent / allUnreadable）不注入正文，指纹不变。
 * 指纹表的**作用不变**：它仍然锁住「开关关闭时逐字节稳定」，只是基线随这一次
 * 有意修复重抓；G6b-R3 的量具自检（改一个输入字节指纹必变）仍必须绿。
 */
const HEAD_FINGERPRINTS = Object.freeze({
  default: 'e3df30a0969d887193e45f00b08102a68ab9313275c0a6f576f209287d03db1e',
  preview0: '9161deceea37d3fcb3b05558af25dbe945d238bc0f1827612bed711e3080f0a7',
  exclude: '6db6e49166cfb1e5ff21fb0860e54bf7d7a16ce7a2d902d56a7f98978b27f558',
  turn0: '145f4742973a0a7d0190a5c27eaec422afb350e1976006b9fc2591812c5a9c2b',
  badPreview: '5e66cb486725a8d7334a33e06410f9739fa5dc164d3b7b74c2da31a28afe5d80',
  emptySearch: '1ef344420829e342b168b490d70cb0012a8736e86ee439d938213f284d85d960',
  indexAbsent: '640295052edb78ab6f56f5d3d58f9a37f6692d0a7f98e34fb2686c93867dc2e8',
  allUnreadable: '6592d84fb0eb4a10013180e44c84822a1c35099604470f6e8472cf82b53d20cf',
  capShrink: 'fd28ecaca8276ea39cd947fbaeb6cf5be1e8582c2f0be53aef53ebfc03e8c8a3',
  truncated: '6598451331ca51ab055a473426cdc86945ed4664b89fae3079fb3c84d1eaa8fd',
  turnGate: '11ed626eca92e8ed9224cc6747e99b1500efa9cc7555ba65a5fdd57c0f361655',
})

function providerOf({ hits = [], failReads = 0, oovTerms = [], indexAbsent = false } = {}) {
  let reads = 0
  return {
    async search() {
      return { display: hits, pack: hits, dropped: [], oovTerms, ...(indexAbsent ? { indexAbsent: true } : {}) }
    },
    async read(id) {
      reads += 1
      if (reads <= failReads) throw new Error('ETRANSIENT 模拟读取暂败')
      const hit = hits.find((row) => row.id === id)
      if (hit === undefined) throw new Error('未命中：' + id)
      return { text: hit.text, record: { createdAt: hit.createdAt ?? 1 } }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'g6b-fake', tier: 'T1', live: true } },
  }
}

function hitsOf(count, bodyLength) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'v3r-' + String(i + 1).padStart(16, '0'),
    score: 1 - i / 100,
    text: MARK + ' 记录' + i + '：' + '材料'.repeat(bodyLength),
    createdAt: 1000 + i,
  }))
}

function metricsOf() {
  const counts = new Map()
  return {
    counts,
    counter(name, value = 1) { counts.set(name, (counts.get(name) ?? 0) + value) },
  }
}

/** 指纹抓取（与改动前的抓取脚本逐行一致；见文件头方法说明）。 */
async function grabFingerprints() {
  const cases = [
    ['default', () => {
      const hits = hitsOf(3, 60)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1, previewChars: 40 }) }
    }],
    ['preview0', () => {
      const hits = hitsOf(2, 30)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1, previewChars: 0 }) }
    }],
    ['exclude', () => {
      const hits = hitsOf(3, 20)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 2, previewChars: 30, excludeRecordIds: [hits[1].id] }) }
    }],
    ['turn0', () => {
      const hits = hitsOf(1, 10)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 0 }) }
    }],
    ['badPreview', () => {
      const hits = hitsOf(1, 10)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1, previewChars: 0.5 }) }
    }],
    ['emptySearch', () => {
      return { deps: { provider: providerOf({ hits: [], oovTerms: ['甲', '乙', '丙'] }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '甲 乙 丙', turn: 1 }) }
    }],
    ['indexAbsent', () => {
      return { deps: { provider: providerOf({ hits: [], indexAbsent: true }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1 }) }
    }],
    ['allUnreadable', () => {
      const hits = hitsOf(2, 10)
      return { deps: { provider: providerOf({ hits, failReads: 2 }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1 }) }
    }],
    ['capShrink', () => {
      const hits = hitsOf(1, 900)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1, previewChars: RECALL_PACK_MAX_CHARS }) }
    }],
    ['truncated', () => {
      const hits = hitsOf(8, 120)
      return { deps: { provider: providerOf({ hits }), sessionKey: SESSION }, invoke: (recall) => recall({ query: '材料', turn: 1, previewChars: 160 }) }
    }],
    ['turnGate', () => {
      const hits = hitsOf(2, 20)
      return {
        deps: { provider: providerOf({ hits }), sessionKey: SESSION },
        invoke: async (recall) => ({
          first: await recall({ query: '材料', turn: 3, previewChars: 30 }),
          second: await recall({ query: '材料', turn: 3, previewChars: 30 }),
        }),
      }
    }],
  ]
  const out = {}
  for (const [name, setup] of cases) {
    const built = setup()
    const recall = createRecall(built.deps)
    let result
    let error = null
    try {
      result = await built.invoke(recall)
    } catch (caught) {
      error = { name: caught?.constructor?.name, code: caught?.code ?? null, message: caught?.message }
    }
    out[name] = sha256(JSON.stringify(result ?? error ?? null))
  }
  return out
}

/* ------------------------------------------------------------ 合成活动面 */

/** 与 v3-g6b-visibility 的快照构建同口径（这里只用到最小字段）。 */
function surfaceOf({ nodes = [], events = [], vouchers = [], forgotten = [], intent = 'absent', recordSeq = {}, registry = null } = {}) {
  return {
    sessionKey: SESSION,
    nodes,
    events,
    vouchers,
    forgotten,
    redactedVoucherIds: [],
    archiveIntent: intent,
    recordSeq,
    recallRegistry: registry,
    generations: { contentGeneration: 0, replaceGeneration: 0 },
  }
}

/** 所有命中记录都「未覆盖」（可再次召回）。 */
function absentSurface(ids) {
  return surfaceOf({
    nodes: [],
    events: [],
    recordSeq: Object.fromEntries(ids.map((id) => [id, 900])),
  })
}

/** 所有命中记录都仍在活动面上（源事件可见）。 */
function visibleSurface(ids) {
  const recordSeq = Object.fromEntries(ids.map((id, index) => [id, index]))
  return surfaceOf({
    nodes: ids.map((_id, index) => index),
    events: ids.map((_id, index) => ({ seq: index, type: 'user/message' })),
    recordSeq,
  })
}

/** 所有命中记录已被归档（回执覆盖）→ 不可见，应再次召回。 */
function archivedSurface(ids) {
  const receiptSeq = ids.length + 1
  const recordSeq = Object.fromEntries(ids.map((id, index) => [id, index]))
  return surfaceOf({
    nodes: [receiptSeq],
    events: [
      ...ids.map((_id, index) => ({ seq: index, type: 'user/message' })),
      { seq: receiptSeq, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, sourceEventSeqs: ids.map((_id, index) => index) },
    ],
    vouchers: [{ voucherId: 'v-1', recordIds: ids, startSeq: 0, endSeq: ids.length - 1, targetEventId: receiptSeq }],
    recordSeq,
  })
}

function visibilityPortOf(snapshot) {
  return {
    calls: 0,
    async snapshotOf({ recordIds = [] } = {}) {
      this.calls += 1
      return typeof snapshot === 'function' ? snapshot({ recordIds }) : snapshot
    },
  }
}

/* ------------------------------------------------------------ off 路径等价 */

test('G6b-R1 off 路径与 HEAD 逐字节等价（11 项冻结指纹）', async () => {
  const current = await grabFingerprints()
  assert.deepEqual(Object.keys(current).sort(), Object.keys(HEAD_FINGERPRINTS).sort(), '指纹表必须覆盖同一组用例')
  const drifted = []
  for (const [name, expected] of Object.entries(HEAD_FINGERPRINTS)) {
    if (current[name] !== expected) drifted.push(name + '：' + expected + ' → ' + current[name])
  }
  assert.deepEqual(drifted, [], '开关关闭时不得有任何字节漂移：\n' + drifted.join('\n'))
})

test('G6b-R2 显式传 visibility 端口但开关关闭：输出仍与 HEAD 逐字节相同，且端口零调用', async () => {
  const hits = hitsOf(3, 60)
  const port = visibilityPortOf(visibleSurface(hits.map((hit) => hit.id)))
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: port, dedupeVisible: false })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(sha256(JSON.stringify(result)), HEAD_FINGERPRINTS.default)
  assert.equal(port.calls, 0, '关闭时不得读取活动面（零副作用、零额外 IO）')
  assert.equal(Object.hasOwn(result, 'dedupe'), false, '关闭时不得出现 dedupe 字段')
})

test('G6b-R3 反假绿：改一个输入字节指纹必变；开关打开必须真的改变输出', async () => {
  const hits = hitsOf(3, 60)
  const changed = hitsOf(3, 60)
  changed[1] = { ...changed[1], text: changed[1].text + '。' }
  const baseRecall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION })
  const changedRecall = createRecall({ provider: providerOf({ hits: changed }), sessionKey: SESSION })
  const a = await baseRecall({ query: '材料', turn: 1, previewChars: 40 })
  const b = await changedRecall({ query: '材料', turn: 1, previewChars: 40 })
  assert.notEqual(sha256(JSON.stringify(a)), sha256(JSON.stringify(b)), '输入变一个字符，指纹必须变（否则「等价」是恒真）')

  const onRecall = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    visibility: visibilityPortOf(visibleSurface(hits.map((hit) => hit.id))),
    dedupeVisible: true,
  })
  const on = await onRecall({ query: '材料', turn: 1, previewChars: 40 })
  assert.notEqual(on.text, a.text, '开关打开必须真的改变注入结果')
  assert.equal(on.injected, false)
})

/* ------------------------------------------------------------ on 路径行为 */

test('G6b-R4 同片段仍可见时不重复：全部命中当前可见 → 不注入并如实计数', async () => {
  const hits = hitsOf(3, 40)
  const metrics = metricsOf()
  const recall = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    metrics,
    visibility: visibilityPortOf(visibleSurface(hits.map((hit) => hit.id))),
    dedupeVisible: true,
  })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, false)
  assert.equal(result.releaseReason, 'all-deduped')
  assert.equal(result.dedupe.skipped, 3)
  assert.equal(result.dedupe.stillVisible, 3)
  assert.equal(result.dedupe.unknown, 0)
  assert.match(result.dedupe.digest, /^[0-9a-f]{16}$/)
  assert.equal(metrics.counts.get('v3.recall.dedupe.skipped'), 3)
  assert.equal(metrics.counts.get('v3.recall.injected'), undefined, '全部跳过时不得计「已注入」')
})

test('G6b-R5 部分可见：只跳过可见片段，其余照常注入并写明跳过条数', async () => {
  const hits = hitsOf(3, 40)
  const ids = hits.map((hit) => hit.id)
  const snapshot = visibleSurface([ids[0]])
  const recall = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    visibility: visibilityPortOf(snapshot),
    dedupeVisible: true,
  })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true)
  assert.equal(result.dedupe.skipped, 1)
  assert.equal(result.injectedHits, result.hits.length)
  assert.ok(!result.presentedIds.includes(ids[0]), '被跳过的片段不得出现在 presentedIds')
  assert.ok(result.presentedIds.includes(ids[1]) && result.presentedIds.includes(ids[2]))
  assert.match(result.text, new RegExp('可见片段去重：跳过 1 条'), result.text.slice(0, 200))
})

test('G6b-R6 消失后可再次召回：归档后（hidden-receipt）必须重新注入', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  const recall = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    visibility: visibilityPortOf(archivedSurface(ids)),
    dedupeVisible: true,
  })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true)
  assert.equal(result.dedupe.skipped, 0)
  assert.deepEqual([...result.presentedIds], ids)
})

test('G6b-R7 不同片段可召回：同文本的其它记录不被误挡；同记录换 span 是另一个键', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  const snapshot = visibleSurface([ids[0]])
  const recall = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    visibility: visibilityPortOf(snapshot),
    dedupeVisible: true,
  })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true)
  assert.deepEqual([...result.presentedIds], [ids[1]], '只有真正可见的那条被跳过')

  const text = '同一段正文'
  const keyA = dedupeKeyOf(SESSION, recordFragmentOf({ id: ids[0], text, span: { unit: 'code-point', start: 0, end: 10 } }))
  const keyB = dedupeKeyOf(SESSION, recordFragmentOf({ id: ids[0], text, span: { unit: 'code-point', start: 10, end: 20 } }))
  const keyC = dedupeKeyOf(SESSION, recordFragmentOf({ id: ids[1], text, span: { unit: 'code-point', start: 0, end: 10 } }))
  assert.notEqual(keyA, keyB, 'span 必须进键（不同窗口是不同片段身份）')
  assert.notEqual(keyA, keyC, '不同记录 ID 必须进键（同文本不合并）')
  const summaryKey = dedupeKeyOf(SESSION, { kind: 'summary', id: 'v3s-0000000000000001', version: recordFragmentOf({ id: 'v3s-0000000000000001', text }).version, span: { unit: 'code-point', start: 0, end: 10 } })
  assert.notEqual(summaryKey, keyA, '摘要工件与记录是两个片段身份（同文本也不得互相挡）')
  assert.equal(keyA.length, 16)
})

test('G6b-R8 文本变更不继承旧可见性：同 ID 换正文 = 另一个片段，旧缓存不得复用', () => {
  const id = 'v3r-00000000000000f1'
  const versionA = recordFragmentOf({ id, text: '第一版正文 材料' })
  const versionB = recordFragmentOf({ id, text: '第二版正文（已更正）材料' })
  const keyA = dedupeKeyOf(SESSION, versionA)
  const keyB = dedupeKeyOf(SESSION, versionB)
  assert.notEqual(keyA, keyB, '正文版本必须进去重键')
  assert.notEqual(versionA.version, versionB.version)

  const state = createVisibilityState()
  const snapshot = absentSurface([id])
  const first = state.evaluate({ snapshot, fragments: [versionA], sessionKey: SESSION })
  assert.equal(first.verdicts[0].dedupeKey, keyA)
  assert.equal(first.cache.hits, 0)
  // 同一活动面、同一 ID、只是正文变了：代际未变，但键变了 → 必须重判而不是沿用旧结论。
  const second = state.evaluate({ snapshot, fragments: [versionB], sessionKey: SESSION })
  assert.equal(second.verdicts[0].dedupeKey, keyB)
  assert.equal(second.cache.hits, 0, '旧正文版本的判定不得被新版本继承')
  assert.equal(second.cache.misses, 1)
  // 再问一次同一版本：这次才允许命中缓存。
  const third = state.evaluate({ snapshot, fragments: [versionB], sessionKey: SESSION })
  assert.equal(third.cache.hits, 1)
})

test('G6b-R9 未知宿主面明确退化：端口抛错 → 全部按可见保守注入，degraded 可见且不崩', async () => {
  const hits = hitsOf(2, 40)
  const port = { async snapshotOf() { throw new Error('ESURFACE 模拟宿主面不可读') } }
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: port, dedupeVisible: true })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true)
  assert.equal(result.dedupe.degraded, true)
  assert.equal(result.dedupe.unknown, 2)
  assert.equal(result.dedupe.skipped, 0, 'unknown 永不进 skip 集合（R-1）')
  assert.match(result.text, /可见性判定降级/, result.text.slice(0, 300))
})

test('G6b-R10 未知重复有界：同会话跨回合累计超过上界后标 unknown-capped，仍照常注入（R-11）', async () => {
  const hits = hitsOf(1, 40)
  const port = visibilityPortOf(null)
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: port, dedupeVisible: true })
  const steps = []
  for (let turn = 1; turn <= VISIBILITY_LIMITS.repeatSession + 1; turn += 1) {
    steps.push(await recall({ query: '材料', turn, previewChars: 40 }))
  }
  const flat = steps.slice(0, VISIBILITY_LIMITS.repeatSession)
  assert.deepEqual(flat.map((step) => step.dedupe.capped), flat.map(() => 0), '上界内不标记')
  const last = steps[steps.length - 1]
  assert.equal(last.dedupe.capped, 1, '超过同会话上界必须标记')
  assert.equal(last.injected, true, '标记不得改变注入决定')
  assert.match(last.text, new RegExp('本回合 ' + VISIBILITY_LIMITS.repeatTurn + ' 次／会话 ' + VISIBILITY_LIMITS.repeatSession + ' 次'), '文案必须由常量插值（不写死数字）')
})

test('G6b-R11 已遗忘片段永不注入（隐私维度优先于去重计数）', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  const snapshot = { ...absentSurface(ids), forgotten: ids }
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: visibilityPortOf(snapshot), dedupeVisible: true })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, false)
  assert.equal(result.dedupe.forgotten, 2)
  assert.equal(result.dedupe.unknown, 0, '遗忘不属于 unknown，不参与重复计数')
})

test('G6b-R12 v1 信任集：restore 后的 visible-restored 判定保留，但按 unknown 注入（R-12）', async () => {
  const hits = hitsOf(1, 40)
  const id = hits[0].id
  const snapshot = surfaceOf({
    nodes: [3],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 2, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, sourceEventSeqs: [0] },
      { seq: 3, type: 'user/message', sourceForm: 'restore', sourceKind: PLUGIN_SOURCE_KIND, sourceEventSeqs: [2] },
    ],
    vouchers: [{ voucherId: 'v-1', recordIds: [id], startSeq: 0, endSeq: 0, targetEventId: 2 }],
    recordSeq: { [id]: 0 },
  })
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: visibilityPortOf(snapshot), dedupeVisible: true })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true, 'v1 只信五态：visible-restored 按 unknown 保守注入')
  assert.equal(result.dedupe.unknown, 1)
  assert.equal(result.dedupe.skipped, 0)
})

test('G6b-R13 判定缓存按代际复用（同快照第二步命中缓存，不重复判定）', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  const port = visibilityPortOf(absentSurface(ids))
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: port, dedupeVisible: true })
  const first = await recall({ query: '材料', turn: 1, previewChars: 40 })
  const second = await recall({ query: '材料', turn: 2, previewChars: 40 })
  assert.equal(first.dedupe.cache.hits, 0)
  assert.equal(second.dedupe.cache.hits, 2, '同代际应复用判定（有界缓存）')
  assert.equal(port.calls, 2)
})

test('G6b-R14 非法配置失败关闭：开关非布尔 / 开启但没有端口都直接拒绝', () => {
  const provider = providerOf({ hits: hitsOf(1, 10) })
  assert.throws(() => createRecall({ provider, sessionKey: SESSION, dedupeVisible: 'yes' }), /dedupeVisible/)
  assert.throws(() => createRecall({ provider, sessionKey: SESSION, dedupeVisible: true }), /visibility 端口/)
  assert.throws(() => createRecall({ provider, sessionKey: SESSION, dedupeVisible: true, visibility: {} }), /visibility 端口/)
})

test('G6b-R15 真实位置语义（乱序活动面）可用：nodes [4,2,3] 也能判出可见并跳过（P1-1）', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  // 宿主 replace 是位置 splice：归档 [0,1] 后活动面是 [4,2,3]（不是 seq 升序）。
  const snapshot = surfaceOf({
    nodes: [4, 2, 3],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
      { seq: 2, type: 'user/message' },
      { seq: 3, type: 'assistant/message' },
      { seq: 4, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, sourceEventSeqs: [0, 1] },
    ],
    vouchers: [{ voucherId: 'v-1', recordIds: [ids[1]], startSeq: 0, endSeq: 1, targetEventId: 4 }],
    recordSeq: { [ids[0]]: 2, [ids[1]]: 900 },
  })
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: visibilityPortOf(snapshot), dedupeVisible: true })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.dedupe.crossSession, false)
  assert.equal(result.dedupe.skipped, 1, '乱序活动面上仍在面内的记录必须被认出')
  assert.deepEqual([...result.presentedIds], [ids[1]])
})

test('G6b-R16 跨会话快照：全部注入 + crossSession 可见 + 文案区分「不是读不到」（P2-1）', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  // 快照属于 session-b，但调用方是 g6b-session：接线错也可能发生，必须显式降级。
  const snapshot = { ...visibleSurface(ids), sessionKey: 'session-b' }
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: visibilityPortOf(snapshot), dedupeVisible: true })
  const result = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(result.injected, true, '跨会话不得当成「当前可见」而跳过')
  assert.equal(result.dedupe.crossSession, true)
  assert.equal(result.dedupe.degraded, true)
  assert.equal(result.dedupe.unknown, 2)
  assert.match(result.text, /不属于本会话/, result.text.slice(0, 300))
})

test('G6b-R17 跨会话快照不得复用/污染本会话缓存（P2-1-residual；同 material 双向）', async () => {
  const hits = hitsOf(2, 40)
  const ids = hits.map((hit) => hit.id)
  // 同 material（节点/事件/凭证/代际完全相同），只有 sessionKey 不同——
  // 可见性摘要**不含** sessionKey，所以不走「缓存隔离」就会命中同摘要缓存。
  const sameSession = visibleSurface(ids)
  const foreignSession = { ...visibleSurface(ids), sessionKey: 'session-b' }
  let mode = 'same'
  const port = { async snapshotOf() { return mode === 'same' ? sameSession : foreignSession } }
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: SESSION, visibility: port, dedupeVisible: true })

  // ① 本会话先判出 visible-surface（写进复用缓存）
  const own = await recall({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(own.injected, false)
  assert.equal(own.dedupe.skipped, 2)
  assert.equal(own.dedupe.cache.hits, 0)
  assert.equal(own.dedupe.crossSession, false)

  // ② 同 material 外来快照：不得命中「可见」缓存（危险方向=误跳过）
  mode = 'foreign'
  const foreignFirst = await recall({ query: '材料', turn: 2, previewChars: 40 })
  assert.equal(foreignFirst.injected, true, '外来快照不得复用本会话的 visible 判定')
  assert.equal(foreignFirst.dedupe.skipped, 0)
  assert.equal(foreignFirst.dedupe.unknown, 2)
  assert.equal(foreignFirst.dedupe.crossSession, true)
  assert.equal(foreignFirst.dedupe.cache.hits, 0, 'cross ⇒ 不读复用缓存')
  assert.match(foreignFirst.text, /不属于本会话/, foreignFirst.text.slice(0, 300))

  // ③ 连续第二步外来：仍 crossSession（外来判定不得写进缓存变粘滞）
  const foreignSecond = await recall({ query: '材料', turn: 3, previewChars: 40 })
  assert.equal(foreignSecond.injected, true)
  assert.equal(foreignSecond.dedupe.crossSession, true)
  assert.equal(foreignSecond.dedupe.cache.hits, 0)

  // ④ 回到本会话：同 material 仍能恢复正确判定（缓存既没被污染也没被清空）
  mode = 'same'
  const back = await recall({ query: '材料', turn: 4, previewChars: 40 })
  assert.equal(back.injected, false)
  assert.equal(back.dedupe.crossSession, false)
  assert.equal(back.dedupe.skipped, 2)
  assert.equal(back.dedupe.cache.hits, 2, '本会话缓存仍在（外来快照没有清空它）')

  // ⑤ 反向：新实例先吃外来快照（unknown 不得进缓存粘住）→ 同 material 本会话必须恢复 visible
  let mode2 = 'foreign'
  const recall2 = createRecall({
    provider: providerOf({ hits }),
    sessionKey: SESSION,
    visibility: { async snapshotOf() { return mode2 === 'same' ? sameSession : foreignSession } },
    dedupeVisible: true,
  })
  const stickyProbe = await recall2({ query: '材料', turn: 1, previewChars: 40 })
  assert.equal(stickyProbe.injected, true)
  assert.equal(stickyProbe.dedupe.crossSession, true)
  mode2 = 'same'
  const recovered = await recall2({ query: '材料', turn: 2, previewChars: 40 })
  assert.equal(recovered.injected, false, '外来快照首判的 unknown 不得粘住后续本会话判定')
  assert.equal(recovered.dedupe.crossSession, false)
  assert.equal(recovered.dedupe.skipped, 2)
  assert.equal(recovered.dedupe.cache.hits, 0, '外来判定从未进缓存')
})
