/**
 * G3 诊断数据的保留/清理 + 只读 policy 汇总 + 旧行兼容（离线）。
 *
 * ## 判据来源
 * - 开发流程 §9.6：诊断数据**按会话隔离、限量保留并纳入 forget 清理**；正文不落日志。
 * - 开发流程 §9.7：G5 只能用**只读 policy 输入端口**拿信号，不得读诊断日志；
 *   「观测不参与归档决策」的守卫保留（导入级判据见 v3-g3-capability 的 C7）。
 * - 开发流程 §9.3：新旧日志兼容；**未知字段不默认为已观测**。
 *
 * ## 断言组
 * R1 压实（keepRows）/ R2 清理（keepRows 0 = forget 路径）/ R3 不碰其它账本 /
 * R4 自动触发的字节上限 / R5 旧行不入汇总（unsampledLegacy，不是 0）/
 * R6 混合新旧行 / R7 只读尾窗口 / R8 空/缺失返回 / R9 正文与原始会话键不出现在端口输入 /
 * R10 `{seq,...record}` 行形状可读（seq 在记录之外）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildCacheObservation, readObservationRowOf } from '../src/v3/contracts/cache-observation.mjs'
import {
  OBSERVATION_RETENTION,
  appendCacheObservation,
  appendUsageLine,
  pruneCacheObservationLedger,
  readObservationPolicyInput,
  readUsageSummary,
} from '../src/v3/adapters/storage/usage-log.mjs'

const PREFIX = 'mcl-g3-retention-'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), PREFIX))
  try { return await body(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

const observationFile = (dir) => path.join(dir, 'cache-observations.jsonl')

async function rowsOf(file) {
  const text = await readFile(file, 'utf8')
  assert.equal(text.endsWith('\n'), true, '压实后的文件必须以换行收尾（否则下次追加会粘行）')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] })

/** 一条可用的观测输入（pre-step 局部面 + usage + 带 attempt 的关联）。 */
function observationInput(seq, extra = {}) {
  return {
    usage: { inputTokens: 10, outputTokens: 1 },
    at: seq * 1000,
    request: { turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    surface: { messages: [msg('user', '问题 ' + seq)] },
    surfaceCoverage: { system: false, tools: false },
    surfaceSnapshot: 'pre-step',
    lifecycle: { sessionKey: 'sess-retention', attempt: 1, attemptState: 'completed' },
    ...extra,
  }
}

/** 把一条 v4 记录降级成**真实 v3 行**（去掉 v4 才有的三段）。 */
function asV3Row(record, seq) {
  const row = structuredClone(record)
  row.contractVersion = 3
  delete row.layers
  delete row.lifecycle
  if (row.surface !== null) delete row.surface.components
  return { seq, ...row }
}

// ---------------------------------------------------------------- R1 压实

test('R1 压实：keepRows 只留最后 N 行，返回 kept/removed，且只留完整行', async () => {
  await withDir(async (dir) => {
    for (let seq = 1; seq <= 6; seq += 1) {
      const result = await appendCacheObservation(dir, seq, observationInput(seq))
      assert.equal(result.ok, true, JSON.stringify(result))
    }
    const pruned = await pruneCacheObservationLedger(dir, { keepRows: 2 })
    assert.equal(pruned.ok, true, JSON.stringify(pruned))
    assert.equal(pruned.kept, 2)
    assert.equal(pruned.removed, 4)
    const rows = await rowsOf(observationFile(dir))
    assert.deepEqual(rows.map((row) => row.seq), [5, 6], '保留的是**最后**两行')
    // 再压一次不产生变化（幂等）
    const again = await pruneCacheObservationLedger(dir, { keepRows: 2 })
    assert.equal(again.removed, 0)
    assert.equal(again.kept, 2)
  })
})

// ---------------------------------------------------------------- R2 清理

test('R2 清理（forget 路径）：keepRows 0 删除本会话诊断文件，不留空壳', async () => {
  await withDir(async (dir) => {
    await appendCacheObservation(dir, 1, observationInput(1))
    const pruned = await pruneCacheObservationLedger(dir, { keepRows: 0 })
    assert.equal(pruned.ok, true, JSON.stringify(pruned))
    assert.equal(pruned.kept, 0)
    assert.equal(pruned.removed, 1)
    await assert.rejects(() => stat(observationFile(dir)), (error) => error?.code === 'ENOENT', '清理必须删文件而不是留空文件')
    const policy = await readObservationPolicyInput(dir)
    assert.equal(policy.ok, false)
    assert.equal(policy.reason, 'no-observations')
  })
})

// ---------------------------------------------------------------- R3 不碰其它账本

test('R3 压实只动观测账本：usage.jsonl 与占用聚合不受影响', async () => {
  await withDir(async (dir) => {
    await appendUsageLine(dir, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 })
    await appendCacheObservation(dir, 1, observationInput(1))
    await pruneCacheObservationLedger(dir, { keepRows: 0 })
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 1, 'usage 聚合必须还在')
    assert.equal(summary.occupancy.latest, 1000)
    await assert.rejects(() => stat(observationFile(dir)), (error) => error?.code === 'ENOENT')
  })
})

// ---------------------------------------------------------------- R4 自动上限

test('R4 追加路径自动压实：超过字节上限后只留尾窗口（行仍完整可解析）', async () => {
  await withDir(async (dir) => {
    // 预填一个超过上限的账本（用合法 JSON 行，模拟长期运行的会话）
    const pad = 'x'.repeat(600)
    const lines = []
    for (let seq = 1; seq <= 600; seq += 1) lines.push(JSON.stringify({ seq, padding: pad }))
    await writeFile(observationFile(dir), lines.join('\n') + '\n', 'utf8')
    const before = (await stat(observationFile(dir))).size
    assert.ok(before > OBSERVATION_RETENTION.maxBytes, '前置：文件必须超过上限（实际 ' + before + '）')

    const appended = await appendCacheObservation(dir, 601, observationInput(601))
    assert.equal(appended.ok, true, JSON.stringify(appended))
    const after = (await stat(observationFile(dir))).size
    assert.ok(after <= OBSERVATION_RETENTION.maxBytes, '追加后必须压回上限内（实际 ' + after + '）')
    const rows = await rowsOf(observationFile(dir))
    assert.equal(rows.at(-1).seq, 601, '最新一行必须保留')
    // 保留下来的行都必须是完整 JSON（没有把半行留下）
    for (const row of rows) assert.equal(typeof row.seq, 'number')
    // 压实后仍能读 policy 汇总
    const policy = await readObservationPolicyInput(dir)
    assert.equal(policy.ok, true, JSON.stringify(policy))
    assert.equal(policy.input.window.toSeq, 601)
  })
})

// ---------------------------------------------------------------- R5 旧行不入汇总

test('R5 旧行（v3）可读但新段为 null：不计入 usage 汇总，单列 unsampledLegacy', async () => {
  await withDir(async (dir) => {
    const built = buildCacheObservation(observationInput(1))
    assert.equal(built.ok, true)
    const legacyRow = asV3Row(built.record, 1)
    await writeFile(observationFile(dir), JSON.stringify(legacyRow) + '\n', 'utf8')
    // 读侧：可读、legacy=true、新段为 null
    const view = readObservationRowOf(legacyRow)
    assert.equal(view.ok, true, JSON.stringify(view))
    assert.equal(view.legacy, true)
    assert.equal(view.record.layers, null)
    assert.equal(view.record.lifecycle, null)
    assert.equal(view.record.surface.components, null)
    // 汇总：旧行的 usage 到达性质不可判定 ⇒ 不入 totals，单列计数
    const policy = await readObservationPolicyInput(dir)
    assert.equal(policy.ok, true, JSON.stringify(policy))
    assert.equal(policy.input.window.rows, 1)
    assert.equal(policy.input.window.legacyRows, 1)
    assert.equal(policy.input.usage.counted, 0, '旧行没有 usageArrival，不得默认 counted')
    assert.equal(policy.input.usage.unsampledLegacy, 1)
    assert.equal(policy.input.usage.unknownArrival, 1)
    assert.equal(policy.input.usage.totals.inputTokens, null, '没有可计数样本 ⇒ null，不是 0')
    assert.equal(policy.input.usage.availability.inputTokens, 'missing')
    assert.equal(policy.input.layers, null, '旧行没有 layers ⇒ null（未知），不按当前默认补')
  })
})

// ---------------------------------------------------------------- R6 混合新旧

test('R6 混合新旧行：只对 counted 的新行求和；窗口与相位计数覆盖两类行', async () => {
  await withDir(async (dir) => {
    const first = buildCacheObservation(observationInput(1))
    const second = buildCacheObservation({
      ...observationInput(2),
      surface: { messages: [msg('user', '问题 1'), msg('assistant', '回答')] },
      previousSurface: first.projection,
    })
    assert.equal(second.ok, true)
    const file = observationFile(dir)
    await writeFile(file, [
      JSON.stringify(asV3Row(first.record, 1)),
      JSON.stringify({ seq: 2, ...second.record }),
    ].join('\n') + '\n', 'utf8')
    const appended = await appendCacheObservation(dir, 3, {
      ...observationInput(3),
      surface: { messages: [msg('user', '问题 1'), msg('assistant', '回答'), msg('user', '新一句')] },
      previousSurface: second.projection,
    })
    assert.equal(appended.ok, true, JSON.stringify(appended))

    const policy = await readObservationPolicyInput(dir, { sessionKey: 'sess-retention' })
    assert.equal(policy.ok, true, JSON.stringify(policy))
    assert.equal(policy.input.window.rows, 3)
    assert.equal(policy.input.window.legacyRows, 1)
    assert.equal(policy.input.usage.counted, 2, '两条 v4 行各一次')
    assert.equal(policy.input.usage.unsampledLegacy, 1)
    assert.equal(policy.input.usage.totals.inputTokens, 20, '10 + 10；旧行不计（不是 30）')
    assert.equal(policy.input.projection.phaseCounts.initial, 1, '旧行首次观测也是 initial')
    assert.equal(policy.input.projection.phaseCounts.append, 2)
    assert.equal(policy.input.projection.lastPhase, 'append')
    // 组件来自最后一条带 surface 的行
    assert.equal(policy.input.components.messages.count, 3)
    assert.equal(policy.input.components.messages.generation, policy.input.projection.epoch)
    assert.equal(policy.input.components.system.coverage, 'unobservable')
    assert.equal(policy.input.usage.additivity.provider, 'deepseek')
    assert.equal(policy.input.usage.additivity.cacheFieldsAddable, true)
    assert.equal(policy.input.layers.wire, 'no-seam')
  })
})

// ---------------------------------------------------------------- R7 尾窗口

test('R7 只读尾窗口：窗口外的旧行不参与汇总（不为汇总读整本账）', async () => {
  await withDir(async (dir) => {
    const file = observationFile(dir)
    const lines = []
    for (let seq = 1; seq <= 200; seq += 1) {
      const built = buildCacheObservation({
        ...observationInput(seq),
        surface: { messages: [msg('user', '问题编号 ' + seq)] },
      })
      assert.equal(built.ok, true)
      lines.push(JSON.stringify({ seq, ...built.record }))
    }
    await writeFile(file, lines.join('\n') + '\n', 'utf8')
    const total = (await stat(file)).size
    const policy = await readObservationPolicyInput(dir, { maxBytes: 8 * 1024 })
    assert.equal(policy.ok, true, JSON.stringify(policy))
    assert.ok(total > 8 * 1024, '前置：文件必须大于窗口（实际 ' + total + '）')
    assert.ok(policy.input.window.rows < 200, '窗口外的行不得被读进来（实际 ' + policy.input.window.rows + '）')
    assert.ok(policy.input.window.rows >= 1)
    assert.ok(policy.input.window.toSeq <= 200)
    assert.equal(policy.input.window.fromSeq, policy.input.window.toSeq - policy.input.window.rows + 1, '窗口连续（丢掉了开头那段半行）')
  })
})

// ---------------------------------------------------------------- R8 空/缺失

test('R8 空/缺失：无目录、无文件、只有坏行都返回结构化失败（不抛、不假装有数据）', async () => {
  assert.deepEqual({ ...(await readObservationPolicyInput(null)) }, { ok: false, reason: 'no-directory' })
  await withDir(async (dir) => {
    assert.deepEqual({ ...(await readObservationPolicyInput(dir)) }, { ok: false, reason: 'no-observations' })
    await writeFile(observationFile(dir), 'not-json\n{\"seq\":2}\n', 'utf8')
    const bad = await readObservationPolicyInput(dir)
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'no-usable-observations')
    // 压实对缺失文件是 no-op（不是错误）
    assert.deepEqual({ ...(await pruneCacheObservationLedger(path.join(dir, 'missing'), { keepRows: 1 })) }, { ok: true, kept: 0, removed: 0 })
  })
})

// ---------------------------------------------------------------- R9 隐私

test('R9 端口输入不含正文、原始会话键或逐行记录', async () => {
  await withDir(async (dir) => {
    const secret = '绝不应出现在汇总里的正文片段'
    await appendCacheObservation(dir, 1, {
      ...observationInput(1),
      surface: { messages: [msg('user', secret)] },
      lifecycle: { sessionKey: 'raw-session-key-should-not-leak', attempt: 1, attemptState: 'completed' },
    })
    const policy = await readObservationPolicyInput(dir, { sessionKey: 'raw-session-key-should-not-leak' })
    assert.equal(policy.ok, true, JSON.stringify(policy))
    const text = JSON.stringify(policy)
    assert.equal(text.includes(secret), false, '汇总不得含正文')
    assert.equal(text.includes('raw-session-key-should-not-leak'), false, '汇总不得含原始会话键')
    assert.equal('rows' in policy.input, false, '端口不得携带逐行记录')
    for (const key of ['records', 'content', 'text', 'credentials', 'prices']) {
      assert.equal(key in policy.input, false, '端口不得含 ' + key)
    }
    // 会话摘要必须与观测行里的那一份同源（同一次哈希）
    const row = JSON.parse((await readFile(observationFile(dir), 'utf8')).trimEnd())
    assert.equal(policy.input.session.id, row.lifecycle.session.id)
  })
})

// ---------------------------------------------------------------- R10 行形状

test('R10 行形状 {seq, ...record}：seq 在记录之外，读侧必须剥掉它才判形状', async () => {
  await withDir(async (dir) => {
    await appendCacheObservation(dir, 7, observationInput(7))
    const raw = JSON.parse((await readFile(observationFile(dir), 'utf8')).trimEnd())
    assert.equal(raw.seq, 7)
    assert.equal('seq' in (readObservationRowOf(raw).record ?? {}), false, 'seq 不属于记录本体')
    assert.equal(readObservationRowOf({ ...raw, extraUnknown: 1 }).ok, false, '未知键仍必须拒绝')
  })
})
