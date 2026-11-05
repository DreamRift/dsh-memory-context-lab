#!/usr/bin/env node
/**
 * P8 §5.4 热路径基准（固定 1k / 10k 合成记录）。
 *
 * 口径（与开发流程 §5.4 对齐，读数为**本机实测**，不是承诺值）：
 * - preStepNoArchive：暖态、无可归档候选时，每步的插件侧额外耗时
 *   = state.json 同步读 + 归档选择器/dry-run（§5.4 首轮目标 p95 ≤ 50 ms）；
 * - autoRecall：自动回注（T1 本地词法索引 + chunk 窗口 + 装包）每回合耗时
 *   （§5.4 首轮目标 p95 ≤ 200 ms）；
 * - coldIndexBuild：1k/10k 条记录的**冷态**索引重建（O(N)，只在维护点/首次建库跑，
 *   不属于热路径；列出来是为了让读者知道「热路径没有搬这项」）。
 *
 * 输出契约（§11）：JSON、键序固定、LF、无时间戳、无绝对路径（临时根显示为 <tmp-root>）。
 * 退出码：0 测量完成；1 结构性失败（回注未注入/命中为 0 等）；2 用法错误。
 *
 * 边界（如实）：
 * - 合成正文（固定模板 + 固定错误码分布），不是真实会话内容，也不读任何用户会话/正式灵枢；
 * - 进程内 T1 路径：不含宿主 request 序列化、网络、真实供应商缓存与 TTFT；
 * - 归档场景是「全部历史已归档」的稳态空转，不含真正提交归档的磁盘/宿主成本；
 * - 读数受本机 CPU、Node 版本、OS 缓存影响；§5.4 的 50/200 ms 是基准机目标，不等于本机达标结论。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { createRecall } from '../src/v3/application/recall.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { readSessionState } from '../src/v3/adapters/storage/session-state.mjs'

const SESSION_ID = 'bench-hotpath'
const SEED_BATCH = 500
const STATE_SAMPLES = 300
const RECALL_SAMPLES = 60
const QUERY = 'ERR_BENCH_17 结论 说明'
const TARGETS = { preStepNoArchiveMs: 50, autoRecallMs: 200, source: '开发流程 §5.4 首轮性能目标（基准机目标，不是现状读数）' }
const LIMITS = [
  '合成正文（固定模板），不读真实会话/正式灵枢；只代表结构规模，不代表真实内容分布',
  '进程内 T1：不含宿主请求序列化、网络、供应商缓存与 TTFT',
  '归档检查是「历史已全部归档」的稳态空转，不含真正提交归档的宿主/磁盘成本',
  '读数为本机实测，受 CPU/Node/OS 缓存影响；§5.4 的 50/200 ms 是基准机目标，未据此宣称达标',
]

function usage(message) {
  if (message !== undefined) console.error('bench-hotpath: ' + message)
  console.error('用法：node scripts/bench-hotpath.mjs [--sizes=1000,10000] [--samples=60]')
  process.exit(2)
}

const argv = process.argv.slice(2)
let sizes = [1000, 10000]
let recallSamples = RECALL_SAMPLES
for (const arg of argv) {
  if (arg === '--help' || arg === '-h') usage()
  const match = /^--(sizes|samples)=(.+)$/.exec(arg)
  if (match === null) usage('未知参数 ' + JSON.stringify(arg))
  if (match[1] === 'sizes') {
    sizes = match[2].split(',').map((part) => Number(part.trim()))
    if (sizes.length === 0 || sizes.some((n) => !Number.isSafeInteger(n) || n < 1)) usage('--sizes 必须是逗号分隔的正整数')
  } else {
    recallSamples = Number(match[2])
    if (!Number.isSafeInteger(recallSamples) || recallSamples < 5) usage('--samples 必须是 ≥5 的整数')
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const round = (value) => (value === null ? null : Math.round(value * 10) / 10)
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? null),
  }
}

const hex16 = (n) => n.toString(16).padStart(16, '0')

/** 确定性合成正文：固定模板、固定错误码分布（不随机）。 */
function benchText(i) {
  return '记录 ' + i + '：模块 memory-bench 处理任务-' + (i % 97) + '；错误码 ERR_BENCH_' + (i % 251)
    + '；结论：第 ' + i + ' 条用例通过，说明如下。'
}

function benchRecord(i) {
  const id = 'v3r-' + hex16(i + 1)
  const text = benchText(i)
  return {
    id,
    kind: 'operation',
    sessionKey: SESSION_ID,
    createdAt: 1792845000000 + i,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-bench-' + i, sourceForm: 'tool/result', transactionId: 'tx-bench' },
  }
}

async function fileBytes(file) {
  try {
    return (await stat(file)).size
  } catch {
    return null
  }
}

async function benchSize(size, root) {
  const { port, store } = await createSessionStorePort(root, SESSION_ID)
  const metrics = { counter() {}, observe() {} }
  try {
    const seedStart = performance.now()
    for (let offset = 0; offset < size; offset += SEED_BATCH) {
      const batch = []
      for (let i = offset; i < Math.min(size, offset + SEED_BATCH); i += 1) batch.push(benchRecord(i))
      await port.transaction(batch)
    }
    const seedMs = Math.round((performance.now() - seedStart) * 10) / 10

    const buildStart = performance.now()
    await port.rebuildIndex()
    const coldIndexBuildMs = Math.round((performance.now() - buildStart) * 10) / 10

    const indexPath = path.join(store.directory, 'lexical-index.json')
    const chunkPath = path.join(store.directory, 'chunk-index.json')

    // 稳态「无归档」：全部历史都已在 lastArchiveEndSeq 之内，选择器扫描后无候选。
    const eventCount = size * 2
    const events = new Array(eventCount)
    const seqToRecordId = new Map()
    const surfaceNodes = new Array(eventCount)
    for (let i = 0; i < size; i += 1) {
      const humanSeq = i * 2
      const assistantSeq = humanSeq + 1
      events[humanSeq] = { seq: humanSeq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: benchText(i) }] } }
      events[assistantSeq] = { seq: assistantSeq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: benchText(i) }] } } }
      surfaceNodes[humanSeq] = humanSeq
      surfaceNodes[assistantSeq] = assistantSeq
      seqToRecordId.set(humanSeq, 'v3r-' + hex16(i + 1))
      seqToRecordId.set(assistantSeq, 'v3r-' + hex16(i + 1))
    }
    const archive = createArchiveService({ store: port, host: {}, clock: { now: () => 1792845000000 }, random: { uuid: () => '00000000-0000-0000-0000-000000000000' } })
    const archiveInput = {
      sessionId: SESSION_ID,
      events,
      surfaceNodes,
      seqToRecordId,
      mode: 'full-history',
      retainOperations: 5,
      lastArchiveEndSeq: eventCount - 1,
    }
    const preCheck = await archive.dryRun(archiveInput)
    if (preCheck.status !== 'no-candidate') {
      throw new Error('基准场景前置失败：稳态无归档预期 no-candidate，得到 ' + preCheck.status)
    }
    const preStepSamples = []
    for (let i = 0; i < STATE_SAMPLES; i += 1) {
      const start = performance.now()
      readSessionState(root, SESSION_ID, { defaultMode: 'full-history' })
      await archive.dryRun(archiveInput)
      preStepSamples.push(performance.now() - start)
    }

    const provider = createT1Provider({ port, store, metrics })
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_ID })
    // 冷态首调（索引 parse + chunk 索引 parse）单独计量，不计入暖态样本：
    // 1k/10k 的 p95 判据是「暖态」，把一次 O(索引大小) 的解析混进 60 个样本只会
    // 变成 p99 噪声（实测 10k 的首调在 0.5s 量级）。
    const coldStart = performance.now()
    const coldOut = await recall({ query: QUERY, turn: 1, previewChars: 240 })
    const coldFirstRecallMs = Math.round((performance.now() - coldStart) * 10) / 10
    if (coldOut.injected !== true) throw new Error('基准预热失败：首调未注入（' + String(coldOut.releaseReason ?? coldOut.reason) + '）')
    if (typeof recall.releasePresentedTurn === 'function') recall.releasePresentedTurn(1)
    const recallDurations = []
    const notInjected = new Map()
    let injected = 0
    let hits = 0
    for (let i = 0; i < recallSamples; i += 1) {
      const start = performance.now()
      const turn = i + 2
      const out = await recall({ query: QUERY, turn, previewChars: 240 })
      recallDurations.push(performance.now() - start)
      // 释放本回合占位（不计入测量）：回注租约窗口是 32 条 pending/handed-off，
      // 连续 60 个回合不放会撞容量上限（那是真实并发保护，不是本基准要测的路径）。
      if (out.injected === true && typeof recall.releasePresentedTurn === 'function') recall.releasePresentedTurn(turn)
      if (out.injected === true) {
        injected += 1
        hits += Array.isArray(out.hits) ? out.hits.length : 0
      } else {
        const reason = String(out.releaseReason ?? out.reason ?? 'unknown')
        notInjected.set(reason, (notInjected.get(reason) ?? 0) + 1)
      }
    }
    if (injected !== recallSamples) {
      throw new Error('自动回注未全部注入（' + injected + '/' + recallSamples + '；未注入原因 ' + JSON.stringify([...notInjected]) + '），读数不可用')
    }
    if (hits === 0) throw new Error('自动回注命中为 0，读数不可用')

    const preSummary = summarize(preStepSamples)
    const recallSummary = summarize(recallDurations)
    return {
      records: size,
      events: eventCount,
      bytes: { chunkIndex: await fileBytes(chunkPath), lexicalIndex: await fileBytes(indexPath) },
      timingMs: { coldFirstRecall: coldFirstRecallMs, coldIndexBuild: coldIndexBuildMs, seed: seedMs },
      metrics: {
        preStepNoArchive: preSummary,
        autoRecall: recallSummary,
      },
      recall: { injected, samples: recallSamples, totalHits: hits, query: QUERY },
      targets: {
        autoRecallP95Pass: recallSummary.p95 !== null && recallSummary.p95 <= TARGETS.autoRecallMs,
        preStepNoArchiveP95Pass: preSummary.p95 !== null && preSummary.p95 <= TARGETS.preStepNoArchiveMs,
      },
    }
  } finally {
    store.close()
  }
}

const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-bench-'))
let exitCode = 0
try {
  const sizesOut = []
  for (const size of sizes) {
    const dir = path.join(root, 'n' + size)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    sizesOut.push(await benchSize(size, dir))
  }
  const output = {
    benchmark: 'v3-hotpath',
    schemaVersion: 1,
    env: { node: process.version, platform: process.platform + '-' + process.arch },
    limits: LIMITS,
    scenarios: sizesOut,
    targets: TARGETS,
  }
  process.stdout.write(JSON.stringify(output, null, 2).split(root).join('<tmp-root>') + '\n')
} catch (error) {
  exitCode = 1
  console.error('bench-hotpath: 结构性失败：' + (error instanceof Error ? error.message : String(error)))
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
process.exit(exitCode)
