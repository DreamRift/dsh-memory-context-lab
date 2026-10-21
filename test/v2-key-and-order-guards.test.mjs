/**
 * 0.13.2 守卫：键冲突与判定顺序（D-14 / D-21 / D-07）。
 *
 * ## 缺陷
 * - **D-14**：grep 键 `<tool>|<pattern>|<path>` 用 `|` 拼接，而 pattern / path 本身
 *   都可能含 `|`：两个完全不同的区间得到同一键 → 假重读、成本账本口径污染、回执
 *   谎报「该区间已于 seq N 归档」。
 * - **D-21a**：读不到 id 的调用块只进 `ambiguousCalls` 不进 `calls`，于是先命中
 *   「空范围」分支，`ambiguousCalls` 检查永远轮不到。`allowPlainText=true` 的调用方
 *   会拿到 `safe:true`——**放行在途调用**。
 * - **D-21b**：活动面没有 `assistant/message` 时 `boundarySeq=null, fenceAll=false`，
 *   栅栏整段被跳过（不是保守拒绝，是**不判**）。可达：第一批归档把助手消息连同结果
 *   换成回执之后。
 * - **D-07**：`jobReferencesOf` 的正则把引号写在冒号**之后**，认不出 JSON 形态
 *   （工具参数的正常形态），于是 `background-job` 硬保护在真实使用中从未建立过；
 *   终态判定又只要「正文含 id + 一个终态词」就解除，太松。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readKeyOf, READ_LEDGER_VERSION } from '../src/v2/read-ledger.mjs'
import { classifyRange, GUARD_CODES, resolveExposureBoundary } from '../src/v2/guard.mjs'
import { jobReferencesOf, collectStructuralProtections } from '../src/protection.mjs'

test('D-14：pattern / path 含分隔符的两个不同区间不得同键（且账本版本已升）', () => {
  assert.equal(READ_LEDGER_VERSION, 2, '键格式变了，账本版本必须升（v1 走 schema 不符失败关闭）')
  const a = readKeyOf('grep', JSON.stringify({ pattern: 'TODO|FIXME', path: 'src/a.mjs' }))
  const b = readKeyOf('grep', JSON.stringify({ pattern: 'TODO', path: 'FIXME|src/a.mjs' }))
  assert.notEqual(a, b, '两个不同区间得到同一键 = 假重读 + 回执谎报归档位置')
  // 同一区间仍必须稳定同键。
  assert.equal(a, readKeyOf('grep', JSON.stringify({ pattern: 'TODO|FIXME', path: 'src/a.mjs' })))
  // read 的键同样不得因路径含分隔符而撞车。
  assert.notEqual(
    readKeyOf('read', JSON.stringify({ file_path: 'a|0', offset: 1 })),
    readKeyOf('read', JSON.stringify({ file_path: 'a', offset: 1 })),
  )
})

const model = { kind: 'model', provider: 'fake', model: 'fake-model' }

function ambiguousSession() {
  // 助手消息里有一个**读不到 id** 的 tool-call 块，且范围里没有其它调用/结果。
  const events = {
    0: { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'p' }], source: { kind: 'system-prompt' } } } },
    1: { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '做点事' }], source: { kind: 'user' } } },
    2: { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{}' }], source: model } } },
    3: { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '完成' }], source: model } } },
  }
  return { events, surfaceSeqs: [0, 1, 2, 3], lastAssistantSeq: 3 }
}

test('D-21a：ambiguousCalls 必须先于「空范围」判定（否则会放行在途调用）', () => {
  const { events, surfaceSeqs, lastAssistantSeq } = ambiguousSession()
  const plain = classifyRange({
    eventAt: (seq) => events[seq] ?? null,
    rangeStart: 2,
    rangeEnd: 2,
    surfaceSeqs,
    lastAssistantSeq,
    allowPlainText: true,
  })
  assert.equal(plain.safe, false, 'allowPlainText=true 时也不得放行读不到 id 的调用块')
  assert.equal(plain.code, GUARD_CODES.AMBIGUOUS_PAIR, `原因码必须是 ambiguous-pair，实际 ${plain.code}`)

  const strict = classifyRange({
    eventAt: (seq) => events[seq] ?? null,
    rangeStart: 2,
    rangeEnd: 2,
    surfaceSeqs,
    lastAssistantSeq,
    allowPlainText: false,
  })
  assert.equal(strict.code, GUARD_CODES.AMBIGUOUS_PAIR, 'allowPlainText=false 时原因码同样必须是 ambiguous-pair')
})

test('D-21b：活动面上没有助手消息时栅栏整段生效（不是「不判」）', () => {
  const events = {
    0: { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'p' }], source: { kind: 'system-prompt' } } } },
    1: { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '需求' }], source: { kind: 'user' } } },
  }
  const exposure = resolveExposureBoundary({ eventAt: (seq) => events[seq] ?? null, surfaceSeqs: [0, 1], claimedSeq: null })
  assert.equal(exposure.fenceAll, true, '没有曝光证据时必须 fenceAll，而不是 boundarySeq=null 后整段跳过')

  const verdict = classifyRange({
    eventAt: (seq) => events[seq] ?? null,
    rangeStart: 1,
    rangeEnd: 1,
    surfaceSeqs: [0, 1],
    lastAssistantSeq: null,
    allowPlainText: true,
  })
  assert.equal(verdict.safe, false)
  assert.equal(verdict.code, GUARD_CODES.NOT_YET_EXPOSED)
})

test('D-07：JSON 形态的 job 引用必须建立硬保护；无关结果不得解除', () => {
  const json = jobReferencesOf('{"command":"hive submit --task 复盘","job_id":"h_abc123"}')
  assert.deepEqual(json, ['h_abc123'], '工具参数的正常形态是 JSON，认不出就等于硬保护从未建立')
  assert.deepEqual(jobReferencesOf('{"job_id": "h_abc123"}'), ['h_abc123'])
  assert.deepEqual(jobReferencesOf('{"payload":{"jobId":"h_abc123"}}'), ['h_abc123'])
  assert.deepEqual(jobReferencesOf('job_id: h_abc123'), ['h_abc123'])
  assert.deepEqual(jobReferencesOf('hive poll --job-id h_abc123'), ['h_abc123'])

  const events = {
    0: { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'p' }], source: { kind: 'system-prompt' } } } },
    1: { type: 'user/message', data: { message: { id: 'u1', role: 'user', content: [{ type: 'text', text: '起一个后台任务' }], source: { kind: 'user' } } } },
    2: { type: 'assistant/message', data: { message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{"command":"hive submit --task 复盘","job_id":"h_abc123"}' }], source: model } } },
    5: { type: 'tool/result', data: { message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: '已提交，job 正在运行' }], source: { kind: 'tool', callId: 'call-1' } } } },
    6: { type: 'assistant/message', data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"file_path":"C:/logs/hive.log"}' }], source: model } } },
    7: { type: 'tool/result', data: { message: { id: 'r2', role: 'tool', content: [{ type: 'text', text: 'h_abc123 上一次 03:12 失败重试（历史记录，与当前运行无关）' }], source: { kind: 'tool', callId: 'call-2' } } } },
  }
  const rows = collectStructuralProtections({
    view: { skipped: [], candidates: [{ rangeStart: 2, rangeEnd: 5 }] },
    surfaceNodes: [0, 1, 2, 5, 6, 7],
    eventAt: (seq) => events[seq] ?? null,
    operationEpoch: 1,
  })
  const jobs = rows.filter((row) => row.source === 'background-job' && row.strength === 'hard')
  assert.equal(jobs.length, 1, 'JSON 形态的 job 启动操作必须拿到 1 条硬保护（无关 read 提到同一 id 不得解除）')
  assert.match(jobs[0].reason, /h_abc123/)
})
