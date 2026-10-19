/**
 * v2 缺陷回归：每一条都对应本轮实际修掉的缺陷，且都能在修复前失败。
 *
 * 覆盖矩阵里「存储事务 / 只读契约 / fork 生命周期 / 预算边界」四组：
 * 这些路径的共同点是**旧测试只测纯函数或手工夹具**，从不走真实调用链，
 * 所以缺陷能在 201 项全绿的套件里长期存活。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore, MAX_TRANSACTION_NUMBER, ENGINE_FILE } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { executeForkClosure, resetForkChild, readForkMap, readNeedsMigration } from '../src/v2/fork.mjs'
import { getEngineRegistry } from '../src/v2/engine.mjs'
import { buildWorkingState, renderWorkingStateCard } from '../src/v2/working-state.mjs'
import { classifyRange, GUARD_CODES } from '../src/v2/guard.mjs'
import { v2SessionDirectoryFor } from '../src/v2/state.mjs'
import { estimateTokensOfBytes, parseBudgetTokens } from '../src/v2/budget.mjs'
import { readRecordById } from '../src/v2/readback.mjs'

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2reg-${name}-`))
  try {
    await body(path.join(root, 'lab'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function spanDraft(text, seq = 1) {
  return draftRecord({
    kind: RECORD_KINDS.PROJECTION_SPAN,
    seq,
    fidelity: 'verbatim',
    inline: { nodeId: `n-${seq}` },
    refs: { sourceKinds: 'user/message', sourceSeqs: String(seq), spanKind: 'history-span' },
    content: text,
  })
}

/** 目录树指纹：相对路径 → 「大小 + mtime」；只读契约就是靠它证明「什么都没动」。 */
async function treeFingerprint(root) {
  const out = new Map()
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(absolute, relative)
      } else {
        const info = await stat(absolute)
        out.set(relative, `${info.size}:${info.mtimeMs}`)
      }
    }
  }
  await walk(root, '')
  return out
}

// ────────────────────────────────────────────────────────────── 事务与稳定 ID

test('提交点之后放弃事务：已提交的权威事务不得被删除', async () => {
  await withTempLab('abandon', async (labRoot) => {
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-abandon' })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('权威原文', 1))

    // 精确复现「提交点已落盘、但提交后的派生步骤失败」的中间态：磁盘上有
    // committedAt，而内存句柄还没释放。旧实现只看内存集合，于是会把权威事务删掉。
    const file = path.join(store.directory, 'transactions', 'txn-00000001.json')
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, `${JSON.stringify({ ...onDisk, committedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')

    const abandoned = await store.abandonTransaction(handle)
    assert.equal(abandoned.abandoned, false)
    assert.equal(abandoned.reason, 'committed')
    await assert.doesNotReject(stat(file), '已提交事务文件必须还在')

    store.close()
    const reopened = await V2SessionStore.open({ labRoot, sessionId: 's-abandon' })
    const loaded = await reopened.readRecord('t00000001-r0000')
    assert.equal(loaded.integrity, 'ok')
    assert.equal(loaded.payloadText, '权威原文')
    reopened.close()
  })
})

test('显式事务号不得覆盖磁盘上的既有事务（号不复用、不覆盖）', async () => {
  await withTempLab('overwrite', async (labRoot) => {
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-overwrite' })
    const first = await store.openTransaction({ txn: 1 })
    await store.stageRecord(first, spanDraft('第一版原文', 1))
    await store.commitTransaction(first)

    // 旧实现只查内存集合，于是这里会整文件重写成第二版，且 warnings 为空。
    await assert.rejects(
      () => store.openTransaction({ txn: 1 }),
      (error) => error.code === 'EINVAL' && /拒绝覆盖/.test(error.message),
    )
    const loaded = await store.readRecord('t00000001-r0000')
    assert.equal(loaded.payloadText, '第一版原文')
    store.close()
  })
})

test('停用即写入屏障：停用后不得提交停用前打开的事务', async () => {
  await withTempLab('disable', async (labRoot) => {
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-disable' })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('停用前暂存', 1))
    await store.disable('test-disable')

    await assert.rejects(
      () => store.commitTransaction(handle),
      (error) => error.code === 'EREADONLY',
    )
    await assert.rejects(
      () => store.stageRecord(handle, spanDraft('停用后追加', 2)),
      (error) => error.code === 'EREADONLY',
    )
    store.close()

    // 重开确认磁盘上确实没有这次写入。
    const reopened = await V2SessionStore.open({ labRoot, sessionId: 's-disable' })
    assert.equal(reopened.recordCount, 0, '停用后的提交不得落盘')
    reopened.close()
  })
})

test('载荷同地址必须同内容：内容寻址的既有文件不符时拒绝写入', async () => {
  await withTempLab('payload', async (labRoot) => {
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-payload' })
    // 在内容寻址的目标路径上放一份「名字对、内容错」的文件（磁盘损坏/恶意替换的
    // 等价形态）。旧实现只比长度，于是写入「成功」、直到回读才以 hash-mismatch 暴露。
    const text = 'aaaa'
    const hex = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    const target = path.join(store.directory, 'payloads', hex.slice(0, 2), hex)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from('bbbb', 'utf8'))

    const handle = await store.openTransaction()
    await assert.rejects(
      () => store.stageRecord(handle, spanDraft(text, 1)),
      (error) => error.code === 'EHASH',
    )
    store.close()
  })
})

test('打开失败不得毒化注册表：磁盘修好后同进程仍可重新打开', async () => {
  await withTempLab('poison', async (labRoot) => {
    const directory = v2SessionDirectoryFor(labRoot, 's-poison')
    // 先制造一个「目录存在但事务目录是个文件」的坏形态，让 #reconcile 失败。
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-poison' })
    store.close()
    await rm(path.join(directory, 'transactions'), { recursive: true, force: true })
    await writeFile(path.join(directory, 'transactions'), 'not-a-directory', 'utf8')

    await assert.rejects(() => V2SessionStore.open({ labRoot, sessionId: 's-poison' }))

    // 修好磁盘：旧实现里注册项不会回滚，于是同进程内永久 EOPEN，只能重启进程。
    await rm(path.join(directory, 'transactions'), { force: true })
    const reopened = await V2SessionStore.open({ labRoot, sessionId: 's-poison' })
    assert.equal(reopened.recordCount, 0)
    reopened.close()
  })
})

test('事务号越界与非法号一律给 EngineV2Error，不抛裸 RangeError', async () => {
  await withTempLab('txnrange', async (labRoot) => {
    const store = await V2SessionStore.init({ labRoot, sessionId: 's-txnrange' })
    for (const bad of [0, -1, MAX_TRANSACTION_NUMBER + 1, 1.5]) {
      await assert.rejects(
        () => store.openTransaction({ txn: bad }),
        (error) => error.name === 'EngineV2Error' && error.code === 'EINVAL',
        `事务号 ${bad} 必须被拒且带 code`,
      )
    }
    store.close()
  })
})

// ─────────────────────────────────────────────────────────────── 只读契约

test('只读打开不产生任何磁盘副作用：文件树与时间戳逐项不变', async () => {
  await withTempLab('readonly', async (labRoot) => {
    const sessionId = 's-readonly'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('只读前写入的正文', 1))
    await store.commitTransaction(handle)
    store.close()

    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    const before = await treeFingerprint(directory)

    const readOnly = await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
    await readOnly.readRecord('t00000001-r0000')
    readOnly.listEntries({ limit: 100 })
    readOnly.close()

    const after = await treeFingerprint(directory)
    assert.deepEqual([...after.entries()], [...before.entries()], '只读读取前后文件树（含 mtime）必须完全一致')
    await assert.rejects(() => stat(path.join(directory, 'transactions', 'quarantine')), '只读不得新建 quarantine 目录')
  })
})

test('只读打开遇到崩溃遗留事务时不移动文件（保全取证现场）', async () => {
  await withTempLab('readonly-quarantine', async (labRoot) => {
    const sessionId = 's-readonly-q'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('崩溃遗留载荷', 1))
    store.close() // 不提交：模拟崩溃

    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    const before = await treeFingerprint(directory)

    const readOnly = await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
    assert.ok(readOnly.warnings.length >= 0)
    readOnly.close()

    const after = await treeFingerprint(directory)
    assert.deepEqual([...after.entries()], [...before.entries()], '只读对账不得移动/重写崩溃遗留事务')
  })
})

// ──────────────────────────────────────────────────────────── fork 与生命周期

test('活动父会话可 fork：借用既有句柄而不是重开（消除假 EFORKBLOCKED）', async () => {
  await withTempLab('fork-active', async (labRoot) => {
    const parentId = 's-fork-parent'
    const parent = await V2SessionStore.init({ labRoot, sessionId: parentId })
    const handle = await parent.openTransaction()
    await parent.stageRecord(handle, spanDraft('父会话正文', 1))
    await parent.commitTransaction(handle)
    // 父会话**保持打开**（活动会话的真实状态）：旧实现自己再 open 一次必得 EOPEN。

    const result = await executeForkClosure({
      labRoot,
      parentSessionId: parentId,
      childSessionId: 's-fork-child',
    })
    assert.equal(result.recordCount, 1)
    assert.equal(result.mapping['t00000001-r0000'], 't00000001-r0000', '子记录沿用父事务号，ID 逐字相同')

    // 父句柄仍然可用（借用方不得关闭别人的句柄）。
    assert.equal(parent.recordCount, 1)
    parent.close()
  })
})

test('synthesized 记录带载荷时按内容复制，指纹一致（旧实现只复制 verbatim）', async () => {
  await withTempLab('fork-synth', async (labRoot) => {
    const parentId = 's-fork-synth'
    const parent = await V2SessionStore.init({ labRoot, sessionId: parentId })
    const handle = await parent.openTransaction()
    await parent.stageRecord(handle, spanDraft('verbatim 正文', 1))
    // synthesized + payload：import-v1 指针、surface 替换跨度都是这个形状。
    await parent.stageRecord(handle, draftRecord({
      kind: RECORD_KINDS.PROJECTION_SPAN,
      seq: 2,
      fidelity: 'synthesized',
      inline: { nodeId: 'n-2' },
      refs: { sourceKinds: 'user/message', sourceSeqs: '2', spanKind: 'history-span' },
      content: 'synthesized 载荷正文',
    }))
    await parent.commitTransaction(handle)
    parent.close()

    const result = await executeForkClosure({
      labRoot,
      parentSessionId: parentId,
      childSessionId: 's-fork-synth-child',
    })
    assert.equal(result.recordCount, 2)

    const child = await V2SessionStore.open({ labRoot, sessionId: 's-fork-synth-child' })
    const loaded = await child.readRecord('t00000001-r0001')
    assert.equal(loaded.integrity, 'ok')
    assert.equal(loaded.payloadText, 'synthesized 载荷正文', 'synthesized 载荷必须按内容复制')
    child.close()
  })
})

test('fork 失败可重试：带 needs-migration 的半成品可被 fork-reset 清掉', async () => {
  await withTempLab('fork-retry', async (labRoot) => {
    const parentId = 's-fork-retry'
    const childId = 's-fork-retry-child'
    const parent = await V2SessionStore.init({ labRoot, sessionId: parentId })
    const handle = await parent.openTransaction()
    await parent.stageRecord(handle, spanDraft('父正文', 1))
    await parent.commitTransaction(handle)
    parent.close()

    // 造一个「上次 fork 留下的半成品」：子库有记录 + needs-migration 标记。
    const stuckChild = await V2SessionStore.init({ labRoot, sessionId: childId })
    const stuckHandle = await stuckChild.openTransaction()
    await stuckChild.stageRecord(stuckHandle, spanDraft('半成品残留', 1))
    await stuckChild.commitTransaction(stuckHandle)
    stuckChild.close()
    await writeFile(
      path.join(v2SessionDirectoryFor(labRoot, childId), 'needs-migration.json'),
      `${JSON.stringify({
        kind: 'dsh-memory-context-lab/v2/needs-migration',
        schemaVersion: 1,
        parentSessionId: parentId,
        reason: 'simulated',
        markedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      'utf8',
    )
    assert.ok(await readNeedsMigration(labRoot, childId))

    const reset = await resetForkChild({ labRoot, childSessionId: childId })
    assert.equal(reset.reset, true)

    // 重试必须成功，且父 ID 在子库可回读。
    const result = await executeForkClosure({ labRoot, parentSessionId: parentId, childSessionId: childId })
    assert.equal(result.recordCount, 1)
    const child = await V2SessionStore.open({ labRoot, sessionId: childId })
    const loaded = await child.readRecord('t00000001-r0000')
    assert.equal(loaded.payloadText, '父正文')
    child.close()
    assert.equal(await readNeedsMigration(labRoot, childId), null, '成功后标记必须清除')
  })
})

test('fork-reset 只清带标记的半成品，不碰真实子账本', async () => {
  await withTempLab('fork-reset-guard', async (labRoot) => {
    const childId = 's-real-child'
    const child = await V2SessionStore.init({ labRoot, sessionId: childId })
    const handle = await child.openTransaction()
    await child.stageRecord(handle, spanDraft('真实数据', 1))
    await child.commitTransaction(handle)
    child.close()

    await assert.rejects(
      () => resetForkChild({ labRoot, childSessionId: childId }),
      (error) => error.code === 'EINVAL',
    )
    const reopened = await V2SessionStore.open({ labRoot, sessionId: childId })
    assert.equal(reopened.recordCount, 1, '没有标记的账本不得被清掉')
    reopened.close()
  })
})

test('fork 后的子会话是「未激活」而不是「已激活」，可直接 on', async () => {
  await withTempLab('fork-child-state', async (labRoot) => {
    const parentId = 's-fork-state-parent'
    const childId = 's-fork-state-child'
    const parent = await V2SessionStore.init({ labRoot, sessionId: parentId })
    const handle = await parent.openTransaction()
    await parent.stageRecord(handle, spanDraft('正文', 1))
    await parent.commitTransaction(handle)
    parent.close()

    await executeForkClosure({ labRoot, parentSessionId: parentId, childSessionId: childId })
    const registry = getEngineRegistry(labRoot, childId)
    assert.equal(registry.v2Active, false, 'fork 只是搬冷库，子会话尚未声明所有权')
    assert.equal(registry.damaged, false)
    // fork 只搬冷库，子会话尚未声明所有权——holder 必须是 null。
    assert.equal(registry.holder, null)
  })
})

test('fork-map 落盘且可读（旧 ID 回读的来源凭证）', async () => {
  await withTempLab('fork-map', async (labRoot) => {
    const parentId = 's-map-parent'
    const parent = await V2SessionStore.init({ labRoot, sessionId: parentId })
    const handle = await parent.openTransaction()
    await parent.stageRecord(handle, spanDraft('正文', 1))
    await parent.commitTransaction(handle)
    parent.close()

    await executeForkClosure({ labRoot, parentSessionId: parentId, childSessionId: 's-map-child' })
    const map = await readForkMap(labRoot, 's-map-child')
    assert.equal(map.parentSessionId, parentId)
    assert.equal(map.mapping['t00000001-r0000'], 't00000001-r0000')
  })
})

// ─────────────────────────────────────────────────────────── 引擎互斥与损坏

test('在途调用来自活动面（冷库账本为空时也不得报「在途动作：无」）', () => {
  // 场景：助手刚发出一个工具调用，结果还没回来。这条调用当然还没进冷库
  // （冷库要等结算、归档之后才有），所以只查 store.openCalls() 会得到「无在途」。
  const events = new Map([
    [1, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下测试' }] } }],
    [2, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          content: [{ type: 'tool-call', id: 'call-live-1', name: 'run_tests', arguments: '{}' }],
        },
      },
    }],
    [3, { type: 'tool/call', data: { callId: 'call-live-1', name: 'run_tests' } }],
  ])

  const state = buildWorkingState({
    sessionId: 's-inflight',
    surfaceNodes: [1, 2, 3],
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    lastAssistantSeq: 2,
  })

  assert.equal(state.unclosedPairCount, 1, '活动面上未配对的调用必须算作在途')
  assert.equal(state.openActions.length, 1)
  const [action] = state.openActions
  assert.equal(action.callId, 'call-live-1')
  assert.equal(action.toolName, 'run_tests')
  assert.equal(action.source, 'surface:unpaired-tool-call', '来源必须标明是活动面事实而不是冷库账本')

  const card = renderWorkingStateCard(state)
  assert.match(card.text, /在途动作 call-live-1/)
  assert.match(card.text, /活动面未配对调用/)
  assert.doesNotMatch(card.text, /在途动作（无）/, '不得把「有在途调用」渲染成「无」')

  // 结果回来后就不再是在途调用——同一份输入换成带结果的表面，必须清零。
  events.set(4, { type: 'tool/result', data: { message: { id: 'r1', toolCallId: 'call-live-1' } } })
  const settled = buildWorkingState({
    sessionId: 's-inflight',
    surfaceNodes: [1, 2, 3, 4],
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [],
    lastAssistantSeq: 2,
  })
  assert.equal(settled.unclosedPairCount, 0)
})

test('冷库账本与活动面合并去重：同一个 callId 只算一次', () => {
  const events = new Map([
    [1, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { id: 'a1', content: [{ type: 'tool-call', id: 'call-dup', name: 'grep' }] },
      },
    }],
  ])
  const state = buildWorkingState({
    sessionId: 's-dup',
    surfaceNodes: [1],
    eventAt: (seq) => events.get(seq) ?? null,
    openCalls: [{ callId: 'call-dup', callRecordId: 't00000001-r0001' }],
    lastAssistantSeq: 1,
  })
  assert.equal(state.unclosedPairCount, 1, '同一 callId 不得被算两次')
  // 活动面优先：它是宿主事实，冷库账本只是补充。
  assert.equal(state.openActions[0].source, 'surface:unpaired-tool-call')
})

test('v2 状态损坏时如实报 damaged 且不报告持有者', async () => {
  await withTempLab('damaged', async (labRoot) => {
    const sessionId = 's-damaged'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    store.close()

    const engineFile = path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE)
    await writeFile(engineFile, '{ this is not json', 'utf8')

    const registry = getEngineRegistry(labRoot, sessionId)
    assert.equal(registry.damaged, true, '损坏必须与缺失区分开')
    assert.equal(registry.holder, null, '损坏时不得报告任何持有者')
  })
})

test('普通历史跨度不被当成「空范围」拒绝，而工具操作仍按配对要求', () => {
  // 一个只有助手正文、没有任何工具调用的区间：v1 口径下这是空范围（拒），
  // v2 声明 allowPlainText 后必须放行——否则「全历史」里占绝大多数的普通
  // user/assistant 正文永远退不了热。
  const events = new Map([
    [2, {
      seq: 2,
      type: 'assistant/message',
      // 宿主契约形状：正文与 source 都在 `data.message` 下，结算坐标是 `data.turn/step`。
      data: { turn: 1, step: 1, message: { id: 'a-2', source: { kind: 'model' }, content: [{ type: 'text', text: '普通分析正文' }] } },
    }],
    [3, {
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { id: 'a-3', source: { kind: 'model' }, content: [{ type: 'text', text: '后续结算' }] } },
    }],
  ])
  const eventAt = (seq) => events.get(seq) ?? null
  const surfaceSeqs = [2, 3]
  // 已曝光：区间之后还有一次助手结算（v2 只会为已曝光的范围建候选）。
  const lastAssistantSeq = 3

  const v1View = classifyRange({ eventAt, rangeStart: 2, rangeEnd: 2, surfaceSeqs, lastAssistantSeq })
  assert.equal(v1View.safe, false, 'v1 口径：没有工具调用的区间是空范围')
  assert.equal(v1View.code, GUARD_CODES.EMPTY_RANGE)

  const v2View = classifyRange({
    eventAt,
    rangeStart: 2,
    rangeEnd: 2,
    surfaceSeqs,
    lastAssistantSeq,
    allowPlainText: true,
  })
  assert.equal(v2View.safe, true, 'v2 口径：普通历史跨度必须可退热')

  // 但「真的读不到事件」的区间仍然拒——豁免只针对「没有工具调用」，不是放宽读取。
  const unreadable = classifyRange({
    eventAt: () => null,
    rangeStart: 2,
    rangeEnd: 2,
    surfaceSeqs,
    lastAssistantSeq,
    allowPlainText: true,
  })
  assert.equal(unreadable.safe, false, '读不到事件的区间一律拒，不被 allowPlainText 放行')
})

test('v2 状态缺失时才允许 v1 接管（缺失 ≠ 损坏）', async () => {
  await withTempLab('missing', async (labRoot) => {
    const registry = getEngineRegistry(labRoot, 's-never-enabled')
    assert.equal(registry.damaged, false)
    assert.equal(registry.holder, null)
  })
})

// ─────────────────────────────────────────────────────────── 预算边界语义

test('预算参数：0 / 负数 / 小数 / 字符串 / 超限一律结构化报错，不静默换值', () => {
  for (const bad of [0, -1, 12.5, '6000', Number.NaN, Infinity, 32_001]) {
    const plan = parseBudgetTokens(bad, { fallback: 6000, max: 32_000 })
    assert.equal(plan.ok, false, `${JSON.stringify(bad)} 必须被拒`)
    assert.match(plan.error, /budget_tokens|预算/)
  }
  const omitted = parseBudgetTokens(undefined, { fallback: 6000, max: 32_000 })
  assert.equal(omitted.ok, true)
  assert.equal(omitted.value, 6000)
  assert.equal(omitted.source, 'default')
  const exact = parseBudgetTokens(32_000, { fallback: 6000, max: 32_000 })
  assert.equal(exact.ok, true)
  assert.equal(exact.value, 32_000)
})

test('token 估算：字节数走 estimateTokensOfBytes，不二次编码', () => {
  assert.equal(estimateTokensOfBytes(4000), 1000)
  assert.equal(estimateTokensOfBytes(1), 1)
  assert.equal(estimateTokensOfBytes(0), 0)
})

test('第一条记录同样受预算约束：预算不足时不整条塞回，并给出可执行告警', async () => {
  await withTempLab('first-record', async (labRoot) => {
    const sessionId = 's-first'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    const big = 'x'.repeat(40_000) // ≈10000 token
    await store.stageRecord(handle, spanDraft(big, 1))
    await store.commitTransaction(handle)
    store.close()

    // 直接走回读层（runtime.recall 的 ids 分支即调用它）。
    const reopened = await V2SessionStore.open({ labRoot, sessionId })
    const page = await readRecordById(labRoot, sessionId, 't00000001-r0000', { store: reopened })
    assert.equal(page.integrity, 'ok')
    reopened.close()

    // 预算 100 token 装不下 ≈10000 token 的单条：必须截断并显式说明。
    const truncated = await readRecordById(labRoot, sessionId, 't00000001-r0000', {
      store: await V2SessionStore.open({ labRoot, sessionId }),
      maxBytes: 400,
    })
    assert.equal(truncated.integrity, 'prefix', '有界读取必须如实报告「只读了前缀」')
    assert.equal(truncated.truncated, true)
    assert.ok(truncated.payloadText.length < big.length)
  })
})

// ── 第二轮独立复核发现（每条都是「测试全绿但真实链路会出错」的缺陷） ──────────

test('隔离区事务号继续占用：重开后不得复用已隔离事务的号', async () => {
  await withTempLab('quarantine-txn', async (labRoot) => {
    const sessionId = 's-quar'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('第一条', 1))
    await store.commitTransaction(handle)
    store.close()

    // 制造一个崩溃遗留事务（未提交），让重开时把它隔离掉。
    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    await writeFile(path.join(directory, 'transactions', 'txn-00000002.json'), '{"kind":"broken"')

    // 关键在**第二次**重开：第一次把 txn-2 移进 quarantine/ 后，transactions/ 里
    // 已经没有它了；如果隔离区的号不计入 maxSeenTxn，号就会回落并被复用，
    // 于是旧回执里的稳定 ID 静默指向另一条无关记录。
    const second = await V2SessionStore.open({ labRoot, sessionId })
    second.close()

    const third = await V2SessionStore.open({ labRoot, sessionId })
    const thirdHandle = await third.openTransaction()
    assert.equal(thirdHandle.txn, 3, '隔离掉的号 2 必须继续占用，不能被复用')
    await third.commitTransaction(thirdHandle)
    third.close()

    const quarantined = await readdir(path.join(directory, 'quarantine'))
    assert.equal(quarantined.length, 1, '崩溃遗留事务必须留在隔离区（保全取证）')
  })
})

test('并发打开同一目录必须被拒绝，不得两个句柄并存覆盖历史', async () => {
  await withTempLab('concurrent-open', async (labRoot) => {
    const sessionId = 's-conc'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('唯一正文', 1))
    await store.commitTransaction(handle)
    store.close()

    // 同一 tick 发起两次 open：占用检查与登记之间隔着 await，旧实现会双双通过。
    const results = await Promise.allSettled([
      V2SessionStore.open({ labRoot, sessionId }),
      V2SessionStore.open({ labRoot, sessionId }),
    ])
    const opened = results.filter((result) => result.status === 'fulfilled' && result.value)
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(opened.length, 1, '同目录只能有一个句柄')
    assert.equal(rejected.length, 1, '第二个打开必须失败关闭，而不是并存')
    assert.match(String(rejected[0].reason?.code ?? rejected[0].reason?.message), /EOPEN/)
    opened[0].value.close()

    // 历史必须完好：并存的旧实现会整文件互相覆盖，正文直接消失。
    const reopened = await V2SessionStore.open({ labRoot, sessionId })
    const loaded = await reopened.readRecord('t00000001-r0000')
    assert.equal(loaded.payloadText, '唯一正文')
    reopened.close()
  })
})

test('工具输出必须满足自己的 output.schema：预算非法时 budget_tokens 为 null 也合法', async () => {
  const { toToolValue, V2_RECALL_TOOL_OUTPUT_SCHEMA } = await import('../src/v2/tool.mjs')
  // 参数错误路径：runtime 返回 budgetTokens=null，此时输出必须仍然合法。
  const value = toToolValue('s-1', {
    mode: 'none',
    entries: [],
    warnings: [],
    error: 'budget_tokens 必须是正整数（收到 0）；本次未执行。',
    usedTokens: 0,
    budgetTokens: null,
    matchedBy: null,
    nextCursor: null,
  })
  assert.equal(value.budget_tokens, null)
  // 声明的 schema 必须允许 null —— 否则宿主在 render 之前抛 INVALID_TOOL_OUTPUT，
  // 这条「参数错误」信息永远到不了模型。
  const declared = V2_RECALL_TOOL_OUTPUT_SCHEMA.properties.budget_tokens
  const allowsNull = declared.type === 'null'
    || (Array.isArray(declared.type) && declared.type.includes('null'))
    || JSON.stringify(declared).includes('null')
  assert.ok(allowsNull, `budget_tokens 必须声明为可空，实际声明：${JSON.stringify(declared)}`)
})

test('工作集默认载荷种类引用真实 kind：默认调用必须真的带上正文', async () => {
  await withTempLab('payload-kinds', async (labRoot) => {
    const sessionId = 's-kinds'
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('正文必须出现', 1))
    await store.commitTransaction(handle)
    store.close()

    const { packWorkingSet, DEFAULT_PAYLOAD_KINDS } = await import('../src/v2/readback.mjs')
    assert.ok(
      DEFAULT_PAYLOAD_KINDS.includes(RECORD_KINDS.PROJECTION_SPAN),
      '默认载荷种类必须包含真实 kind（曾写成下划线字面量，includes 恒 false）',
    )
    const packed = await packWorkingSet(labRoot, sessionId, { budgetTokens: 4000 })
    const withText = packed.entries.filter((entry) => typeof entry.text === 'string' && entry.text.length > 0)
    assert.ok(withText.length > 0, '默认调用必须附带载荷正文，而不是只有记录头')
    assert.ok(withText.some((entry) => entry.text.includes('正文必须出现')))
  })
})

test('工作状态卡按 seq 查记录走倒排索引，不随库大小线性变慢', async () => {
  /** 建一个有 `count` 条记录的会话，返回单次 idsBySeq 的平均纳秒数。 */
  async function measure(labRoot, sessionId, count) {
    const store = await V2SessionStore.init({ labRoot, sessionId })
    const handle = await store.openTransaction()
    for (let index = 0; index < count; index += 1) {
      await store.stageRecord(handle, spanDraft(`正文 ${index}`, index + 1))
    }
    await store.commitTransaction(handle)
    store.close()

    const reopened = await V2SessionStore.open({ labRoot, sessionId })
    const probe = () => {
      const started = process.hrtime.bigint()
      for (let round = 0; round < 300; round += 1) reopened.idsBySeq(count)
      return Number(process.hrtime.bigint() - started) / 300
    }
    probe() // 预热
    const value = Math.min(probe(), probe(), probe())
    assert.deepEqual(reopened.idsBySeq(7), [`t00000001-r0006`])
    reopened.close()
    return value
  }

  await withTempLab('seq-index-small', async (labRoot) => {
    const small = await measure(labRoot, 's-seq-small', 100)
    await withTempLab('seq-index-large', async (largeRoot) => {
      const large = await measure(largeRoot, 's-seq-large', 800)
      // 全库扫描的旧实现是 O(记录数)：8 倍记录 ≈ 8 倍耗时。倒排索引后两者都是
      // 常数级。用「倍数」而不是绝对耗时断言，避免受机器负载影响。
      assert.ok(
        large < small * 4 + 2000,
        `seq 查询成本不得随库大小线性增长：100 条 ${small}ns → 800 条 ${large}ns`,
      )
    })
  })
})

test('未接语义后端时如实说明字面索引的覆盖范围，不让「0 命中」被读成「库里没有」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-warn-'))
  try {
    const { createV2Runtime } = await import('../src/v2/runtime.mjs')
    const sessionId = 's-warn-literal'
    const store = await V2SessionStore.init({ labRoot: root, sessionId })
    const handle = await store.openTransaction()
    await store.stageRecord(handle, spanDraft('正文里才有的词：量子隧穿', 1))
    await store.commitTransaction(handle)
    store.close()

    const runtime = createV2Runtime({
      labRoot: root,
      logger: null,
      // 刻意不给 semanticBackend / semanticBackendFor：本安装没接后端。
    })
    const result = await runtime.recall(sessionId, { query: '量子隧穿', budgetTokens: 2000 })
    const warnings = result.warnings.join('\n')
    assert.match(warnings, /只走内置字面索引/)
    assert.match(warnings, /index sync/)
    assert.equal(result.matchedBy, 'literal', '没有后端时不得标成 literal+semantic')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
