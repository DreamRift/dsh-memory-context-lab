/**
 * P2-b 投影观测合同（0.15.0，合同 v3）——纯函数层守卫。
 *
 * ## 判据来源
 * - 开发流程 §3.4：同一语义内容两次渲染逐字节相同；可变数字不进固定前缀；宿主改面使 epoch 失效。
 * - 开发流程 §3.5：逐请求关联 projectionEpoch、模型标识、系统/工具/消息摘要；未知用 null。
 * - P0 宿主合同 §2.1/§2.5：pre-step 只拿 claimed messages，system/tools 组装在 step() 内部；
 *   观测范围只有 plugin-surface，没有 wire seam。
 * - P2 专题文档「unknown 必须保持 null/unknown，不得伪造缓存命中事实」。
 *
 * ## 断言组
 * H1 封闭集与版本 / H2 无前值=未知 / H2b initial⇒epoch 0 / H3 steady / H4 append /
 * H5 rewrite（含删除；firstDivergence=首个差异下标）/
 * H6 部分覆盖不伪造 system/tools 结论 / H7 全量覆盖下 system 变化可辨 /
 * H8 跨进程消息链种子 / H9 摘要缓存与不可序列化消息 / H10 sanitize 严格 /
 * H11 正文不回显 / H12 确定性（两次构造逐字节相同）/ H13 不产出命中/计费结论 /
 * H14 账本往返（projection 链 + 跨进程种子）/ H14b 种子版本与 epoch 校验（单一真源）/
 * H15 种子扫描窗口（窗口外 → null；窗口内 → 接上）。
 *
 * ## 不适用条件
 * 只验纯函数与账本原语；真实宿主 deriveMessages()、真实 usage 形态与供应商语义未验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  CACHE_PROJECTION_SEED_VERSIONS,
  CACHE_TOKENS_CONTRACT_VERSION,
  COVERAGE_STATES,
  PROJECTION_PHASES,
  SURFACE_SNAPSHOT_POINTS,
  buildCacheObservation,
  messageDigestOf,
  nextProjectionEpoch,
  projectionSeedOf,
  sanitizeCacheObservation,
  surfaceFingerprintOf,
} from '../src/v3/contracts/cache-observation.mjs'
import { appendCacheObservation, readCacheProjectionState } from '../src/v3/adapters/storage/usage-log.mjs'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-p2b-'))
  try { return await body(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

const msg = (role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], ...extra })
const partial = (messages) => ({ messages })
const PRE_STEP = { system: false, tools: false }

function buildOf(messages, extra = {}) {
  const built = buildCacheObservation({
    usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 410 },
    at: 1700000000000,
    request: { turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    surface: partial(messages),
    surfaceCoverage: PRE_STEP,
    surfaceSnapshot: 'pre-step',
    ...extra,
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  return built
}

// ---------------------------------------------------------------- H1 封闭集

test('H1 合同 v3 封闭集：相位/采样点/覆盖度（顺序固定，均可枚举）', () => {
  assert.equal(CACHE_TOKENS_CONTRACT_VERSION, 4)
  assert.deepEqual([...PROJECTION_PHASES], ['initial', 'steady', 'append', 'epoch-start'])
  assert.deepEqual([...SURFACE_SNAPSHOT_POINTS], ['pre-step'])
  assert.deepEqual([...COVERAGE_STATES], ['observed', 'unobservable'])
})

// ---------------------------------------------------------------- H2 无前值

test('H2 无前值 = 未知：messageChange/phase 不得是 unchanged/steady，epoch 0 且 prefixChanged null', () => {
  const built = buildOf([msg('user', '同一句'), msg('assistant', '同一答')])
  const surface = built.record.surface
  assert.equal(surface.messageChange, null, '没有前一次观测 → messageChange null')
  assert.equal(surface.phase, 'initial')
  assert.equal(surface.epoch, 0)
  assert.equal(surface.reason, null)
  assert.equal(surface.firstDivergence, null)
  assert.deepEqual(surface.coverage, { system: 'unobservable', tools: 'unobservable', messages: 'observed' })
  assert.equal(surface.snapshot, 'pre-step')
  assert.equal(surface.messageChain.length, 2)
  assert.match(surface.messageChain.value, /^[0-9a-f]{16}$/)
  const epoch = nextProjectionEpoch(null, { fingerprint: surface.fingerprint, digest: null, messageChange: null, coverage: surface.coverage })
  assert.equal(epoch.prefixChanged, null)
  assert.equal(epoch.epoch, 0)
})

test('H2b initial 必须从 0 起算：没有 fingerprint 的前值不得把孤立 epoch 带进来', () => {
  // 旧入参 previousSurfaceEpoch 已经删除；这里钉死同族形态：前值对象只有 epoch、没有指纹。
  const built = buildOf([msg('user', '问')], { previousSurface: { epoch: 5 } })
  assert.equal(built.record.surface.phase, 'initial')
  assert.equal(built.record.surface.epoch, 0, 'initial ⇒ 0，不得出现 initial + epoch=5')
  const epoch = nextProjectionEpoch({ epoch: 5 }, { fingerprint: 'a'.repeat(16), digest: null, messageChange: null, coverage: { system: 'unobservable', tools: 'unobservable', messages: 'observed' } })
  assert.equal(epoch.phase, 'initial')
  assert.equal(epoch.epoch, 0)
})

// ---------------------------------------------------------------- H3 steady

test('H3 同内容再观测 = steady（epoch 不动，reason null）', () => {
  const messages = [msg('user', '问'), msg('assistant', '答')]
  const first = buildOf(messages)
  const second = buildOf(messages, { previousSurface: first.projection })
  assert.equal(second.record.surface.messageChange, 'unchanged')
  assert.equal(second.record.surface.phase, 'steady')
  assert.equal(second.record.surface.epoch, 0)
  assert.equal(second.record.surface.reason, null)
  assert.equal(second.record.surface.firstDivergence, null)
  assert.equal(second.record.surface.fingerprint, first.record.surface.fingerprint)
})

// ---------------------------------------------------------------- H4 append

test('H4 尾部追加 = append：epoch 不推进，reason=message-appended', () => {
  const first = buildOf([msg('user', '问'), msg('assistant', '答')])
  const second = buildOf([msg('user', '问'), msg('assistant', '答'), msg('user', '新一句')], { previousSurface: first.projection })
  const surface = second.record.surface
  assert.equal(surface.messageChange, 'appended')
  assert.equal(surface.phase, 'append')
  // 记录的 reason 只说明「代际为什么推进」：追加不推进 epoch ⇒ reason 为 null；
  // 「尾部追加」这一事实由 messageChange 表达（surfaceFingerprintOf 自身的 reason 仍是 message-appended）
  assert.equal(surface.reason, null)
  assert.equal(surface.epoch, 0, '内容增长不是缓存失效')
  assert.equal(surface.firstDivergence, null)
  assert.equal(surface.messageChain.length, 3)
})

// ---------------------------------------------------------------- H5 rewrite

test('H5 同位置改写/删除 = epoch-start（firstDivergence 定位；只报投影前缀变化）', () => {
  const first = buildOf([msg('user', '问'), msg('assistant', '答')])
  const rewritten = buildOf([msg('user', '换了一句'), msg('assistant', '答')], { previousSurface: first.projection })
  const rewrite = rewritten.record.surface
  assert.equal(rewrite.messageChange, 'message-prefix-rewritten')
  assert.equal(rewrite.phase, 'epoch-start')
  assert.equal(rewrite.reason, 'message-prefix-rewritten')
  assert.equal(rewrite.firstDivergence, 0)
  assert.equal(rewrite.epoch, 1)
  assert.equal('cacheInvalidated' in rewrite, false, '不得宣称供应商缓存失效')

  // 删除尾部（旧序列不是新序列的前缀）：也是前缀改写。
  // firstDivergence = **首个不再有对应项的下标**；这里数值等于新长度，但不是「新长度」统计量。
  const removed = buildOf([msg('user', '问')], { previousSurface: first.projection })
  assert.equal(removed.record.surface.messageChange, 'message-prefix-rewritten')
  assert.equal(removed.record.surface.firstDivergence, 1)
  assert.equal(removed.record.surface.epoch, 1)

  // 中间删除：[一, 二, 三] → [一, 三]：首个差异下标是 1（不是新长度 2）
  const three = buildOf([msg('user', '一'), msg('assistant', '二'), msg('user', '三')])
  const middleRemoved = buildOf([msg('user', '一'), msg('user', '三')], { previousSurface: three.projection })
  assert.equal(middleRemoved.record.surface.messageChange, 'message-prefix-rewritten')
  assert.equal(middleRemoved.record.surface.firstDivergence, 1, '首个差异下标是内容不同的位置，不是新长度')
  assert.equal(middleRemoved.record.surface.epoch, 1)

  // 旧序列更短、且在第 1 位就不同：[一, 二] → [一, 改, 三]：首个差异下标 1，不是新长度 3
  const short = buildOf([msg('user', '一'), msg('assistant', '二')])
  const longerRewrite = buildOf([msg('user', '一'), msg('assistant', '改'), msg('user', '三')], { previousSurface: short.projection })
  assert.equal(longerRewrite.record.surface.messageChange, 'message-prefix-rewritten')
  assert.equal(longerRewrite.record.surface.firstDivergence, 1, '定位是首个差异下标，不是新长度')
})

// ---------------------------------------------------------------- H6 部分覆盖

test('H6 部分覆盖：system/tools 不可观测，不参与变更判定（不得把「没看」说成「没变」）', () => {
  const first = surfaceFingerprintOf({ messages: [msg('user', '问')], system: 'A', tools: [{ name: 'read' }] }, { coverage: PRE_STEP })
  const second = surfaceFingerprintOf({ messages: [msg('user', '问')], system: 'B', tools: [{ name: 'write' }] }, { coverage: PRE_STEP, previous: first })
  assert.equal(first.digest.system, null)
  assert.equal(first.digest.tools, null)
  assert.deepEqual(first.coverage, { system: 'unobservable', tools: 'unobservable', messages: 'observed' })
  assert.equal(second.reason, null, 'system/tools 未观测时不得报 system-changed/tools-changed')
  assert.equal(second.messageChange, 'unchanged')
  const epoch = nextProjectionEpoch({ epoch: 0, fingerprint: first.fingerprint, digest: first.digest }, second)
  assert.equal(epoch.prefixChanged, false, '只有消息面时，判据也只覆盖消息面')
  assert.equal(epoch.epoch, 0)
  assert.equal(epoch.phase, 'steady')
})

test('H7 全量覆盖：system 变化可辨并推进 epoch', () => {
  const base = surfaceFingerprintOf({ messages: [msg('user', '问')], system: 'A', tools: [] })
  const changed = surfaceFingerprintOf({ messages: [msg('user', '问')], system: 'B', tools: [] }, { previous: base })
  assert.equal(changed.reason, 'system-changed')
  assert.deepEqual([...changed.fieldsChanged], ['system'])
  const epoch = nextProjectionEpoch({ epoch: 2, fingerprint: base.fingerprint, digest: base.digest }, changed)
  assert.equal(epoch.epoch, 3)
  assert.equal(epoch.phase, 'epoch-start')
})

// ---------------------------------------------------------------- H8 跨进程种子

test('H8 跨进程种子（只有消息链）：追加/改写可判，firstDivergence 只能 null', () => {
  const first = buildOf([msg('user', '问'), msg('assistant', '答')])
  const seed = { epoch: 0, fingerprint: first.record.surface.fingerprint, digest: { system: null, tools: null, messages: null, messageChain: first.record.surface.messageChain } }

  const appended = surfaceFingerprintOf({ messages: [msg('user', '问'), msg('assistant', '答'), msg('user', '新')] }, { coverage: PRE_STEP, previous: seed })
  assert.equal(appended.messageChange, 'appended')
  assert.equal(appended.firstDivergence, null)
  assert.equal(nextProjectionEpoch(seed, appended).epoch, 0)

  const rewritten = surfaceFingerprintOf({ messages: [msg('user', '换'), msg('assistant', '答')] }, { coverage: PRE_STEP, previous: seed })
  assert.equal(rewritten.messageChange, 'message-prefix-rewritten')
  assert.equal(rewritten.firstDivergence, null, '跨进程没有逐消息摘要，定位不了首次差异')
  const epoch = nextProjectionEpoch(seed, rewritten)
  assert.equal(epoch.epoch, 1)
  assert.equal(epoch.phase, 'epoch-start')

  const truncated = surfaceFingerprintOf({ messages: [msg('user', '问')] }, { coverage: PRE_STEP, previous: seed })
  assert.equal(truncated.messageChange, 'message-prefix-rewritten')

  // 种子形状不完整（旧 v2 行 / 手改行）→ 不得猜 unchanged
  const noChain = surfaceFingerprintOf({ messages: [msg('user', '问')] }, { coverage: PRE_STEP, previous: { epoch: 0, fingerprint: 'a'.repeat(16), digest: { system: null, tools: null, messages: null, messageChain: null } } })
  assert.equal(noChain.messageChange, null)
  assert.equal(nextProjectionEpoch({ epoch: 4, fingerprint: 'a'.repeat(16), digest: {} }, noChain).epoch, 4, '判不出就不推进')
})

// ---------------------------------------------------------------- H9 摘要缓存

test('H9 摘要缓存一致；不可序列化/非法摘要 → 消息面 unobservable 且不猜变更', () => {
  const messages = [msg('user', '问'), msg('assistant', '答')]
  const computed = surfaceFingerprintOf({ messages }, { coverage: PRE_STEP })
  const cached = surfaceFingerprintOf({ messages }, { coverage: PRE_STEP, messageDigests: messages.map((m) => messageDigestOf(m)) })
  assert.equal(cached.fingerprint, computed.fingerprint, '缓存摘要必须与现算逐位一致')

  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(messageDigestOf(cyclic), null)
  const broken = surfaceFingerprintOf({ messages: [cyclic] }, { coverage: PRE_STEP })
  assert.equal(broken.coverage.messages, 'unobservable')
  assert.equal(broken.digest.messages, null)
  assert.equal(broken.digest.messageChain, null)

  const forged = surfaceFingerprintOf({ messages }, { coverage: PRE_STEP, messageDigests: ['not-a-digest', '0'.repeat(16)] })
  assert.equal(forged.coverage.messages, 'unobservable', '非法摘要不得被当成合法内容')
})

// ---------------------------------------------------------------- H10 sanitize

test('H10 sanitize 严格：request 标识符、phase/coverage/snapshot 枚举、消息链形状、版本与未知键', () => {
  const built = buildOf([msg('user', '问')])
  const base = built.record
  assert.equal(sanitizeCacheObservation(base).ok, true)

  const tamper = (mutate) => {
    const copy = structuredClone(base)
    mutate(copy)
    return sanitizeCacheObservation(copy)
  }
  assert.equal(tamper((r) => { r.request.turn = -1 }).ok, false)
  assert.equal(tamper((r) => { r.request.step = 1.5 }).ok, false)
  assert.equal(tamper((r) => { r.request.provider = '正文'.repeat(20) }).ok, false)
  assert.equal(tamper((r) => { r.request.provider = 7 }).ok, false)
  assert.equal(tamper((r) => { r.request.turn = null }).ok, false, '配对必须同时给 turn/step')
  assert.equal(tamper((r) => { r.surface.phase = 'bogus' }).ok, false)
  assert.equal(tamper((r) => { r.surface.coverage = { system: 'observed', tools: 'observed' } }).ok, false, 'coverage 三键必须齐全')
  assert.equal(tamper((r) => { r.surface.coverage.system = 'unknown' }).ok, false)
  assert.equal(tamper((r) => { r.surface.snapshot = 'outbound' }).ok, false)
  assert.equal(tamper((r) => { r.surface.messageChain.value = 'ZZZZ' }).ok, false)
  assert.equal(tamper((r) => { r.surface.messageChain.length = -1 }).ok, false)
  assert.equal(tamper((r) => { r.surface.messageChain = 'chain' }).ok, false)
  assert.equal(tamper((r) => { r.receiptText = '正文' }).ok, false)
  assert.equal(tamper((r) => { r.contractVersion = 2 }).ok, false, 'v2 记录按版本拒绝')
  assert.equal(sanitizeCacheObservation({ ...base, request: null }).ok, true, '未知配对是合法状态')
  assert.equal(sanitizeCacheObservation({ ...base, surface: null }).ok, true, '未知投影是合法状态')
})

// ---------------------------------------------------------------- H11 正文不回显

test('H11 正文只进指纹：记录里不出现任何消息原文/系统提示/工具 schema', () => {
  const secret = '这是一段绝不应该出现在观测记录里的正文'
  const built = buildOf([msg('system', '固定系统提示'), msg('user', secret)])
  const text = JSON.stringify(built.record)
  for (const fragment of [secret, '固定系统提示', 'content', 'text']) {
    assert.equal(text.includes(fragment), false, '不得含正文片段：' + fragment)
  }
  assert.match(built.record.surface.fingerprint, /^[0-9a-f]{16}$/)
  assert.match(built.record.surface.messageChain.value, /^[0-9a-f]{16}$/)
})

// ---------------------------------------------------------------- H12 确定性

test('H12 确定性：同语义、不同键序 → 两次构造逐字节相同', () => {
  const a = buildOf([{ role: 'user', content: [{ text: '问', type: 'text' }] }])
  const b = buildOf([{ content: [{ type: 'text', text: '问' }], role: 'user' }])
  assert.equal(JSON.stringify(a.record), JSON.stringify(b.record))
  assert.equal(a.record.surface.fingerprint, b.record.surface.fingerprint)
})

// ---------------------------------------------------------------- H13 不产结论

test('H13 不产出命中/计费/延迟结论：记录键里没有任何 cache-hit/金额/TTFT 字段', () => {
  const built = buildOf([msg('user', '问')])
  const keys = []
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner) }
  }
  walk(built.record)
  const forbidden = ['cacheHit', 'cacheHitRate', 'hitRate', 'hit', 'miss', 'cacheMiss', 'uncached', 'billedInput', 'mutuallyExclusive', 'cost', 'price', 'ttft', 'ttftMs']
  for (const key of forbidden) assert.equal(keys.includes(key), false, '不得产出：' + key)
  assert.equal('cacheInvalidated' in built.record, false)
})

// ---------------------------------------------------------------- H14 账本往返

test('H14 账本往返：append 返回 projection，下一行沿用它；重启后从尾部种子接上代际链', async () => {
  await withDir(async (dir) => {
    const messages = [msg('user', '问')]
    const firstInput = {
      usage: { inputTokens: 10, outputTokens: 2 },
      at: 1,
      request: { turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      surface: partial(messages),
      surfaceCoverage: PRE_STEP,
      surfaceSnapshot: 'pre-step',
    }
    const first = await appendCacheObservation(dir, 1, firstInput)
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.appended, true)
    assert.equal(first.projection.epoch, 0)

    const second = await appendCacheObservation(dir, 2, {
      ...firstInput,
      at: 2,
      request: { turn: 1, step: 2, provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      surface: partial([...messages, msg('assistant', '答')]),
      previousSurface: first.projection,
    })
    assert.equal(second.ok, true, JSON.stringify(second))
    const rows = (await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].surface.epoch, 0)
    assert.equal(rows[1].surface.phase, 'append')
    assert.equal(rows[1].surface.epoch, 0)

    // 重启：只从账本尾部拿到 epoch/指纹/消息链
    const seed = await readCacheProjectionState(dir)
    assert.equal(seed.epoch, 0)
    assert.equal(seed.fingerprint, rows[1].surface.fingerprint)
    assert.deepEqual(seed.digest.messageChain, rows[1].surface.messageChain)

    // 同内容 → steady；改写 → epoch 1（跨进程无逐消息摘要，定位 null）
    const steady = await appendCacheObservation(dir, 3, {
      usage: { inputTokens: 10, outputTokens: 2 },
      at: 3,
      request: { turn: 1, step: 3 },
      surface: partial([...messages, msg('assistant', '答')]),
      surfaceCoverage: PRE_STEP,
      surfaceSnapshot: 'pre-step',
      previousSurface: seed,
    })
    assert.equal(steady.ok, true)
    assert.equal(steady.projection.epoch, 0)

    const rewrite = await appendCacheObservation(dir, 4, {
      usage: { inputTokens: 10, outputTokens: 2 },
      at: 4,
      request: { turn: 1, step: 4 },
      surface: partial([msg('user', '改写后的问')]),
      surfaceCoverage: PRE_STEP,
      surfaceSnapshot: 'pre-step',
      previousSurface: steady.projection,
    })
    assert.equal(rewrite.ok, true)
    assert.equal(rewrite.projection.epoch, 1)
    const last = JSON.parse((await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n').at(-1))
    assert.equal(last.surface.messageChange, 'message-prefix-rewritten')
    assert.equal(last.surface.firstDivergence, 0)

    // 没有可用种子（文件不存在）→ null，不伪造 initial 之外的结论
    assert.equal(await readCacheProjectionState(path.join(dir, 'missing')), null)
  })
})

test('H14b 种子判据单一真源：版本/指纹/epoch/消息链都走合同层 projectionSeedOf', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'cache-observations.jsonl')
    const validSurface = { fingerprint: 'c'.repeat(16), epoch: 3, messageChain: { length: 2, value: 'd'.repeat(16) } }
    const row = (seq, extra) => JSON.stringify({ seq, contractVersion: 4, observationScope: 'plugin-surface', ...extra })

    // v2 旧行 + 完全合法的 surface 形状：旧实现会把它当种子（缺陷 P3-1）
    await writeFile(file, row(1, { contractVersion: 2, surface: validSurface }) + '\n', 'utf8')
    assert.equal(await readCacheProjectionState(dir), null, 'v2 行不得冒充种子')

    // 当前合同版本（v4）但缺 epoch：不得伪造 0
    await writeFile(file, row(2, { surface: { fingerprint: 'c'.repeat(16), messageChain: { length: 2, value: 'd'.repeat(16) } } }) + '\n', 'utf8')
    assert.equal(await readCacheProjectionState(dir), null, '缺 epoch 不得伪造 0')

    // 当前合同版本（v4）但 epoch 非法
    await writeFile(file, row(3, { surface: { ...validSurface, epoch: 1.5 } }) + '\n', 'utf8')
    assert.equal(await readCacheProjectionState(dir), null, '非整数 epoch 不得当种子')

    // 当前合同版本（v4）+ 合法 epoch：种子成功，且与合同层判据逐字段一致（单一真源交叉核对）
    await writeFile(file, row(4, { surface: validSurface }) + '\n', 'utf8')
    const seed = await readCacheProjectionState(dir)
    assert.deepEqual(seed, projectionSeedOf(JSON.parse(row(4, { surface: validSurface }))))
    assert.equal(seed.epoch, 3)

    // **v3 旧行仍作种子**：v3→v4 未改 surface 段（指纹/消息链/epoch 同义），
    // 升级当口若不接旧种子，每个存量会话的下一次观测都会 epoch 回退到 0。
    // 这一条同时锁住 CACHE_PROJECTION_SEED_VERSIONS 必须含 3 —— 审查实测「删掉 3 后 14 套仍全绿」，
    // 说明当时的用例只覆盖了 v2 拒绝与 v4 接受，没覆盖 v3 接受这条分支。
    assert.deepEqual([...CACHE_PROJECTION_SEED_VERSIONS], [3, 4], '种子版本集合必须显式含 3 与 4')
    const legacyRow = JSON.parse(row(5, { contractVersion: 3, surface: validSurface }))
    await writeFile(file, JSON.stringify(legacyRow) + '\n', 'utf8')
    const legacySeed = await readCacheProjectionState(dir)
    assert.notEqual(legacySeed, null, 'v3 行必须仍可作种子（否则升级当口 epoch 回退）')
    assert.equal(legacySeed.epoch, 3)
    assert.equal(legacySeed.fingerprint, validSurface.fingerprint)
    assert.deepEqual(legacySeed.digest.messageChain, validSurface.messageChain)
    assert.deepEqual(legacySeed, projectionSeedOf(legacyRow), '同一判据（单一真源）')
    // 反向：版本不在集合里的行（v5，即使 surface 形状完全合法）不得作种子
    await writeFile(file, row(6, { contractVersion: 5, surface: validSurface }) + '\n', 'utf8')
    assert.equal(await readCacheProjectionState(dir), null, '未登记版本不得冒充种子')
  })
})

test('H16 跳过分支（seq 回退 + 有快照）不落行、不回传 projection', async () => {
  await withDir(async (dir) => {
    const messages = [msg('user', '问')]
    const input = {
      usage: { inputTokens: 1, outputTokens: 1 },
      at: 10,
      request: { turn: 1, step: 2 },
      surface: partial(messages),
      surfaceCoverage: PRE_STEP,
      surfaceSnapshot: 'pre-step',
    }
    const first = await appendCacheObservation(dir, 2, input)
    assert.equal(first.ok, true)
    assert.equal(first.appended, true)
    assert.equal(first.projection.epoch, 0)

    // seq 回退到 1：同一份快照（会构造出投影）也必须被跳过，且**不交回 projection**
    const skip = await appendCacheObservation(dir, 1, input)
    assert.equal(skip.ok, true)
    assert.equal(skip.appended, false)
    assert.equal('projection' in skip, false, '未落账的投影不得成为调用方的前值')

    const rows = (await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.length, 1, '跳过行不落账')
    assert.equal((await readCacheProjectionState(dir)).epoch, 0, '账本种子仍是真正落账的那一行')
  })
})

test('H15 同窗口内向后找种子：最后一行没有 surface / 坏形状时，仍取更早的合格行（窗口边界见 H15b）', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'cache-observations.jsonl')
    const withSurface = {
      usage: { inputTokens: 1, outputTokens: 1 },
      at: 1,
      request: { turn: 1, step: 1 },
      surface: partial([msg('user', '问')]),
      surfaceCoverage: PRE_STEP,
      surfaceSnapshot: 'pre-step',
    }
    const first = await appendCacheObservation(dir, 1, withSurface)
    assert.equal(first.ok, true)
    // 同 seq 递增、但**没有投影**的行（配对失败的形态）：不得把种子清掉
    const noSurface = await appendCacheObservation(dir, 2, { usage: { inputTokens: 2, outputTokens: 1 }, at: 2, request: { turn: 1, step: 2 } })
    assert.equal(noSurface.ok, true)
    const seed = await readCacheProjectionState(dir)
    assert.equal(seed.fingerprint, first.projection.fingerprint, '最后一行无 surface 时不得丢种子')
    assert.deepEqual(seed.digest.messageChain, first.projection.digest.messageChain)
    // 旧 v2 形状（surface 字段存在但形状不对）同样不得冒充种子
    await appendCacheObservation(dir, 3, withSurface)
    const raw = (await readFile(file, 'utf8')).trimEnd().split('\n')
    raw.push(JSON.stringify({ seq: 4, contractVersion: 2, observationScope: 'plugin-surface', surface: { fingerprint: 'not-a-fingerprint' } }))
    await writeFile(file, raw.join('\n') + '\n', 'utf8')
    const still = await readCacheProjectionState(dir)
    assert.match(still.fingerprint, /^[0-9a-f]{16}$/, '坏种子不得被当成指纹')
    assert.notEqual(still.fingerprint, 'not-a-fingerprint')
  })
})

test('H15b 窗口边界：种子在 64KiB 尾窗口外 → null；窗口内 → 接上（含 epoch 回退口径）', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'cache-observations.jsonl')
    const seedRow = (seq, epoch, fingerprint) => JSON.stringify({
      seq,
      contractVersion: 4,
      observationScope: 'plugin-surface',
      surface: { fingerprint, epoch, messageChain: { length: 1, value: 'a'.repeat(16) } },
    })
    // 种子行放在文件**开头**，随后塞满「无 surface」的合法行，使尾窗口（64KiB）里没有种子。
    // 这不是靠扩大窗口能读到的形态：读整本账会找到它，现行口径只读尾窗口 ⇒ null。
    const lines = [seedRow(0, 4, 'b'.repeat(16))]
    let seq = 1
    while (Buffer.byteLength(lines.join('\n') + '\n', 'utf8') <= 64 * 1024 + 4096) {
      lines.push(JSON.stringify({ seq, padding: 'x'.repeat(1024) }))
      seq += 1
    }
    await writeFile(file, lines.join('\n') + '\n', 'utf8')
    assert.equal(await readCacheProjectionState(dir), null, '种子在窗口外 → null（下次观测按 initial/epoch 0 起算）')

    // 同一条种子行挪到文件末尾（仍在 64KiB 尾窗口内）→ 必须接上
    await writeFile(file, lines.join('\n') + '\n' + seedRow(seq, 4, 'b'.repeat(16)) + '\n', 'utf8')
    const inside = await readCacheProjectionState(dir)
    assert.equal(inside.epoch, 4, '窗口内的种子必须被读到')
    assert.equal(inside.fingerprint, 'b'.repeat(16))
  })
})
