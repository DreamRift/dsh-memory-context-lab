/**
 * 0.13.2 守卫：guard 的日志专用事件清单必须覆盖宿主已知清单（D-09）。
 *
 * ## 缺陷
 * 宿主 `dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES` 是 62 项，减去 6 个 surface
 * 可见类型是 56 项；guard 只列了 53，漏了 `job/registered`、`job/settled`、
 * `working-directory/change`。这三个都在**工具执行期间**写，正好落在操作区间内，
 * 于是含它们区间永久判 `unknown-event-type`——该操作**永不退热**，而用户只看到
 * 「没按 N 个归档」。
 *
 * ## 判据（改回去必红）
 * - `SURFACE_VISIBLE_TYPES ∪ LOG_ONLY_EVENT_TYPES` 必须覆盖宿主已知清单的全部类型；
 * - 行为层：区间里夹这三个事件时，一个结构合法、配对闭合、已曝光的操作仍然 safe。
 *
 * ## 数据来源与不适用条件
 * 优先从本机 `app.asar` 现场读宿主清单（`MCL_HOST_ASAR` 可覆盖路径）；读不到时
 * 用文件末尾的**快照清单**（2026-10-21 从 app.asar 核验）核对，并在输出里写明
 * 本次用的是快照——**不 SKIP**。SKIP 会被读成通过，而这条缺陷的失败模式正是
 * 「清单和宿主悄悄分家」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'

import {
  classifyRange,
  LOG_ONLY_EVENT_TYPES,
  SURFACE_VISIBLE_TYPES,
} from '../src/v2/guard.mjs'

/** 宿主 dsh-session 的 known-event-types.js 在 asar 内的路径。 */
const HOST_TYPES_PATH = 'dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js'
const DEFAULT_ASAR = 'C:/yinyong/DeepSeek Harness/resources/app.asar'

/** 2026-10-21 从本机 app.asar（dsh-session 0.2.0-rc.2）核验的快照。 */
const HOST_KNOWN_SNAPSHOT = [
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/attempt', 'assistant/message', 'command/done', 'command/run', 'compaction/end',
  'compaction/prune', 'compaction/start', 'compaction/summary', 'deliverables/presented', 'developer/message',
  'feedback/message-delete', 'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked',
  'hook/result', 'image/offload', 'job/registered', 'job/settled', 'llm/retry',
  'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context',
  'request/header', 'sandbox/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted', 'session/end-seed',
  'session/title', 'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog',
  'subagent/descriptor', 'subagent/model-selection-policy', 'system/message', 'team/member', 'team/message/delivered',
  'team/message/queued', 'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start',
  'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'tool/result', 'turn/end', 'turn/start', 'user/message', 'web/deepseek-search-llm-request',
  'working-directory/change', 'workspace/changes',
]

function walkAsar(node, prefix, out) {
  if (!node || typeof node !== 'object') return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walkAsar(child, prefix ? prefix + '/' + name : name, out)
    return
  }
  out.push({ path: prefix, size: node.size ?? 0, offset: node.offset ?? null })
}

async function hostTypesFromAsar(asarPath) {
  const handle = await open(asarPath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    await handle.read(sizeBuf, 0, 8, 0)
    const blockSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(blockSize)
    await handle.read(headerBuf, 0, blockSize, 8)
    const header = JSON.parse(headerBuf.toString('utf8', headerBuf.indexOf(0x7b), headerBuf.lastIndexOf(0x7d) + 1))
    const dataBase = 8 + blockSize
    const all = []
    walkAsar(header, '', all)
    const entry = all.find((row) => row.path === HOST_TYPES_PATH)
    if (!entry) return null
    const buf = Buffer.alloc(entry.size)
    await handle.read(buf, 0, entry.size, dataBase + Number(entry.offset))
    const text = buf.toString('utf8')
    return new Set([...text.matchAll(/'([a-z0-9][a-z0-9/_-]*)'/g)].map((m) => m[1]))
  } finally {
    await handle.close().catch(() => {})
  }
}

async function hostKnownTypes() {
  const asarPath = process.env.MCL_HOST_ASAR || DEFAULT_ASAR
  try {
    const types = await hostTypesFromAsar(asarPath)
    if (types && types.size > 0) return { source: 'asar:' + asarPath, types }
  } catch {
    // 读不到就落到快照：这不是「通过」，是「按已核验快照核对」。
  }
  return { source: 'snapshot(2026-10-21)', types: new Set(HOST_KNOWN_SNAPSHOT) }
}

test('guard 事件清单必须覆盖宿主已知清单的全部非 surface 类型（差集非空即红）', async () => {
  const host = await hostKnownTypes()
  const covered = new Set([...SURFACE_VISIBLE_TYPES, ...LOG_ONLY_EVENT_TYPES])
  const missing = [...host.types].filter((type) => !covered.has(type)).sort()
  assert.deepEqual(
    missing,
    [],
    `宿主已知但 guard 两表都没有（这些区间会被判 unknown-event-type、永不退热）[${host.source}]：${missing.join(', ')}`,
  )
  // 反向：清单里不得出现宿主没有的类型（拼写错会让对应事件被判未知，同样永不退热）。
  const extra = [...LOG_ONLY_EVENT_TYPES].filter((type) => !host.types.has(type)).sort()
  assert.deepEqual(extra, [], `guard 清单里有宿主不认识的事件类型（疑似拼写错误）[${host.source}]：${extra.join(', ')}`)
  console.log(`guard 事件清单核对数据来源：${host.source}（宿主 ${host.types.size} 项）`)
})

function sessionWithInterleaved(innerType) {
  const model = { kind: 'model', provider: 'fake', model: 'fake-model' }
  const events = {
    0: { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'p' }], source: { kind: 'system-prompt' } } } },
    1: { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '读文件' }], source: { kind: 'user' } } },
    2: { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"C:/x.txt"}' }], source: model } } },
    3: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read' } },
    4: { type: innerType, data: { cwd: 'C:/tmp' } },
    5: { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: '文件内容' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' } } },
    6: { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '完成' }], source: model } } },
  }
  return { events, surfaceSeqs: [0, 1, 2, 5, 6], lastAssistantSeq: 6 }
}

test('区间里夹 job/registered、job/settled、working-directory/change 不得让合法操作退不了热', () => {
  for (const type of ['job/registered', 'job/settled', 'working-directory/change']) {
    const { events, surfaceSeqs, lastAssistantSeq } = sessionWithInterleaved(type)
    const verdict = classifyRange({
      eventAt: (seq) => events[seq] ?? null,
      rangeStart: 2,
      rangeEnd: 5,
      surfaceSeqs,
      lastAssistantSeq,
      allowPlainText: false,
    })
    assert.equal(verdict.safe, true, `夹 ${type} 的已闭合已曝光操作必须可退热，实际 code=${verdict.code}`)
  }
})
