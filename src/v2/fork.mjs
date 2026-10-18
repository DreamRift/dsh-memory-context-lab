/**
 * v2 fork（会话分叉）迁移。
 *
 * 规范（新版全历史按需记忆化设计规范 10.2）要求：
 * - 复制所继承 checkpoint 的**可达对象闭包**到子会话隔离根，校验后解除父引用；
 * - ID 可在 namespace 内保持逻辑映射（这里用 fork-map.json 记录父→子映射）；
 * - 父引用在迁移完成前维持保留；失败则子会话进入 needs-migration；
 * - **不偷偷读父目录、不删除父冷库**；
 * - 宿主没有足够 fork 来源信息时，明确阻断并给出迁移步骤，不用空库继续任务。
 *
 * 本模块只做「显式 fork」：父会话必须由调用方点名，子会话必须是尚未建档的新会话。
 * 不做自动推断父会话——推断错了会把别人的历史搬进来，代价远大于让用户敲一个 ID。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { registerProvenanceEdge } from './provenance-index.mjs'
import path from 'node:path'

import { EngineV2Error } from './errors.mjs'
import { draftRecord } from './records.mjs'
import { V2SessionStore } from './store.mjs'
import { v2SessionDirectoryFor } from './state.mjs'

/** 子会话被标记为「需要迁移」时的文件名。 */
export const NEEDS_MIGRATION_FILE = 'needs-migration.json'
/** 父→子记录 ID 映射文件名。 */
export const FORK_MAP_FILE = 'fork-map.json'

export function needsMigrationFileFor(labRoot, sessionId) {
  return path.join(v2SessionDirectoryFor(labRoot, sessionId), NEEDS_MIGRATION_FILE)
}

export function forkMapFileFor(labRoot, sessionId) {
  return path.join(v2SessionDirectoryFor(labRoot, sessionId), FORK_MAP_FILE)
}

/**
 * 只读预览：父会话闭包有多大、能不能搬。
 *
 * 不写任何文件；调用方拿它给用户看，再决定是否执行。
 *
 * `blocked` 只装**真的搬不动**的理由（未提交事务、父库打不开）。对账告警、
 * 父库停用这类**信息性**状态进 `warnings`：它们不阻止搬运（父库停用只是只读，
 * 闭包是完整的），把它们当阻断会让「崩溃后第一次 fork 必失败、纯重试即成功」
 * 这种假失败反复出现。
 */
export async function planForkClosure({ labRoot, parentSessionId, parentStore = null }) {
  if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    throw new EngineV2Error('fork 需要父会话 ID。', { code: 'EINVAL' })
  }
  const parentDirectory = v2SessionDirectoryFor(labRoot, parentSessionId)
  // 先判存在性：父会话根本没有 v2 账本是常态（比如从没用过 v2），
  // 这不是错误，而是「没有可继承闭包」，用 exists:false 如实报告。
  if (!(await V2SessionStore.exists(labRoot, parentSessionId))) {
    return {
      exists: false,
      parentSessionId,
      parentDirectory,
      recordCount: 0,
      payloadBytes: 0,
      pendingTransactions: 0,
      closureFingerprint: null,
      warnings: [],
      blocked: [],
    }
  }

  const blocked = []
  let store = parentStore
  let owned = false
  if (!store) {
    try {
      const acquired = await V2SessionStore.acquireShared({ labRoot, sessionId: parentSessionId, readOnly: true })
      store = acquired.store
      owned = acquired.owned
    } catch (error) {
      // 目录在但打不开：这是真问题（损坏/权限），不猜，直接阻断。
      blocked.push(`父会话 v2 目录不可读：${error instanceof Error ? error.message : String(error)}`)
      return {
        exists: true,
        parentSessionId,
        parentDirectory,
        recordCount: 0,
        payloadBytes: 0,
        pendingTransactions: 0,
        closureFingerprint: null,
        warnings: [],
        blocked,
      }
    }
  }
  try {
    const entries = store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
    let payloadBytes = 0
    for (const entry of entries) {
      payloadBytes += entry.payload?.size ?? 0
    }
    const warnings = [...store.warnings]
    if (store.disabled) {
      warnings.push('父会话 v2 账本处于停用（只读）状态；闭包本身完整，仍可 fork，子会话启用后需自行 /memory-lab2 on')
    }
    const pending = await countPendingTransactions(store.directory)
    if (pending > 0) {
      blocked.push(`父会话有 ${pending} 个未提交事务；先让父会话对账收口再 fork，否则闭包不完整`)
    }
    return {
      exists: true,
      parentSessionId,
      parentDirectory,
      recordCount: entries.length,
      payloadBytes,
      pendingTransactions: pending,
      closureFingerprint: closureFingerprint(entries),
      warnings,
      blocked,
    }
  } finally {
    if (owned) store.close()
  }
}

/**
 * 执行 fork：把父闭包搬进子会话隔离根。
 *
 * 逐条经 `readRecord`（带 hash 校验）读出、再经子库事务写入：
 * 比裸拷文件慢，但保证搬过去的是**校验通过**的原文，且子库事务语义完整。
 * 成功后写 fork-map.json（父ID → 子ID）并返回映射；失败写 needs-migration.json 并抛出。
 */
export async function executeForkClosure({ labRoot, parentSessionId, childSessionId, parentStore = null }) {
  if (parentSessionId === childSessionId) {
    throw new EngineV2Error('父子会话 ID 相同，fork 无意义。', { code: 'EINVAL' })
  }
  if (await V2SessionStore.exists(labRoot, childSessionId)) {
    // 上次 fork 失败会留下一个半成品子库 + needs-migration 标记。标记是
    // 「这个子库由 fork 写出来、且从未被启用过」的凭证（带标记的子会话无法
    // 通过启用检查），所以带标记就一律允许清掉重来——否则失败一次就永久
    // 卡死，用户看到「可重试」而实际永远不可重试，那是死路。
    const stuck = await readNeedsMigration(labRoot, childSessionId)
    // 只有「可解析的」标记才能作为删除子库的凭证。标记损坏（半截 JSON、
    // 结构不符、无权限）时不能把「读不懂」当成「有标记」——那等于凭一个
    // 解析失败的对象删掉可能是真账本的目录。失败关闭，交人工判断。
    const markerValid = stuck !== null && stuck.unreadable !== true
    let count = null
    try {
      const acquired = await V2SessionStore.acquireShared({ labRoot, sessionId: childSessionId, readOnly: true })
      count = acquired.store ? acquired.store.recordCount : 0
      if (acquired.owned) acquired.store?.close()
    } catch (error) {
      // 子库读不动（半成品/损坏）：只有带可解析 needs-migration 标记才敢清，
      // 否则拒绝，避免覆盖一个用户真在用的账本。
      if (!markerValid) throw error
      count = null
    }
    if (markerValid) {
      await rm(v2SessionDirectoryFor(labRoot, childSessionId), { recursive: true, force: true })
    } else if (stuck?.unreadable) {
      throw new EngineV2Error(
        `子会话 ${childSessionId} 的 needs-migration 标记不可读（${stuck.error}）；无法判定它是否 fork 半成品，拒绝自动清理。`
        + ' 请人工检查该子会话目录后，用 `/memory-lab2 fork-reset ' + childSessionId + '` 显式重试（标记仍需可读）。',
        { code: 'EFORKMARKERCORRUPT', details: { childSessionId, error: stuck.error } },
      )
    } else {
      throw new EngineV2Error(
        `子会话 ${childSessionId} 已存在 v2 账本（${count ?? '未知'} 条记录）；fork 只允许写入尚未建档的新会话。`
        + ' 若确认这是上次 fork 的半成品，请先用 `/memory-lab2 fork-reset ' + childSessionId + '` 清掉再重试。',
        { code: 'EINVAL', details: { childSessionId, recordCount: count } },
      )
    }
  }

  const plan = await planForkClosure({ labRoot, parentSessionId, parentStore })
  if (!plan.exists) {
    throw new EngineV2Error(
      `父会话 ${parentSessionId} 没有 v2 账本，没有可继承的闭包。`,
      { code: 'EFORKNOPARENT', details: { plan } },
    )
  }
  if (plan.blocked.length > 0) {
    throw new EngineV2Error(
      `父会话闭包不可迁移：${plan.blocked.join('；')}`,
      { code: 'EFORKBLOCKED', details: { plan } },
    )
  }

  let parent = parentStore
  let parentOwned = false
  if (!parent) {
    const acquired = await V2SessionStore.acquireShared({ labRoot, sessionId: parentSessionId, readOnly: true })
    parent = acquired.store
    parentOwned = acquired.owned
  }
  if (!parent) {
    throw new EngineV2Error(`父会话 ${parentSessionId} 没有 v2 账本，没有可继承的闭包。`, { code: 'EFORKNOPARENT' })
  }
  const childStore = await V2SessionStore.init({ labRoot, sessionId: childSessionId })
  const mapping = {}
  try {
    const entries = parent.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
    // 按父事务号分组、组内保持父顺序：这样逐条经子库事务写入时，
    // 子记录 ID = recordId(父txn, 父index)，与父 ID 逐字相同。
    // 于是「父 ID 在子会话仍可回读」不是靠映射兜底，而是 ID 本身没变；
    // fork-map 只留作来源凭证与跨 namespace 解析。
    const byTxn = new Map()
    for (const entry of entries) {
      const txn = entry.txn
      if (!byTxn.has(txn)) byTxn.set(txn, [])
      byTxn.get(txn).push(entry)
    }
    for (const txn of [...byTxn.keys()].sort((a, b) => a - b)) {
      const group = byTxn.get(txn)
      const handle = await childStore.openTransaction({ txn })
      for (const entry of group) {
        const loaded = await parent.readRecord(entry.id, { verifyHash: true })
        if (loaded.integrity !== 'ok' && loaded.integrity !== 'no-payload') {
          throw new EngineV2Error(
            `父记录 ${entry.id} 完整性检查失败（${loaded.integrity}）；fork 中止，子会话进入 needs-migration。`,
            { code: 'EFORKINTEGRITY', details: { recordId: entry.id, integrity: loaded.integrity } },
          )
        }
        const draft = draftFromEntry(entry, loaded)
        const staged = await childStore.stageRecord(handle, draft)
        mapping[entry.id] = staged.id
      }
      await childStore.commitTransaction(handle)
    }
    // 迁移后核对：父闭包与子闭包的「ID+载荷哈希」指纹必须一致，否则说明搬运有损。
    const parentPrint = closureFingerprint(entries)
    const childEntries = childStore.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
    // mapping 是父→子；核对时要把子 ID 折回父 ID 才能与父指纹同轴比较。
    const reverse = new Map(Object.entries(mapping).map(([parentId, childId]) => [childId, parentId]))
    const childPrint = closureFingerprint(childEntries.map((entry) => ({
      id: reverse.get(entry.id) ?? entry.id,
      payload: entry.payload,
    })))
    if (parentPrint !== childPrint) {
      throw new EngineV2Error(
        `fork 指纹不一致（父 ${parentPrint} ≠ 子 ${childPrint}）；子会话进入 needs-migration。`,
        { code: 'EFORKINTEGRITY', details: { parentPrint, childPrint } },
      )
    }
    await writeFile(
      forkMapFileFor(labRoot, childSessionId),
      `${JSON.stringify({
        kind: 'dsh-memory-context-lab/v2/fork-map',
        schemaVersion: 1,
        parentSessionId,
        childSessionId,
        createdAt: new Date().toISOString(),
        recordCount: Object.keys(mapping).length,
        closureFingerprint: parentPrint,
        mapping,
      }, null, 2)}\n`,
      'utf8',
    )
    // P2-8：软遗忘与来源图随闭包整份迁移。子记录 ID 与父逐字相同，账本键
    // 仍是权威可见性键，整份复制即闭包等价；fork 之后父子账本各自独立演进。
    const parentDir = v2SessionDirectoryFor(labRoot, parentSessionId)
    const childDir = v2SessionDirectoryFor(labRoot, childSessionId)
    for (const sidecar of ['disposition.jsonl', 'provenance.jsonl', 'forget-plans.json']) {
      try {
        const raw = await readFile(path.join(parentDir, sidecar), 'utf8')
        await writeFile(path.join(childDir, sidecar), raw, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await registerProvenanceEdge({
      sessionDir: childDir,
      derivedId: 'fork-map',
      derivedKind: 'fork-map',
      sourceIds: ['session:' + parentSessionId],
    })
    // 子库建成 ≠ 子会话已启用 v2。`init` 建的 engine.json 默认是「已持有投影」，
    // 而这里只是把冷库搬过来，子会话还没有声明过所有权；若照原样留着，
    // 子会话里 `/memory-lab2 on` 会撞 EENGINEACTIVE（明明没启用却说已激活），
    // 用户被迫先 off 再 on——一条未文档化的弯路。所以落盘为「未激活」，
    // 由子会话自己 on 决定是否接管投影。
    await childStore.disable('fork-child-pending-activation')
    await clearNeedsMigration(labRoot, childSessionId)
    return {
      parentSessionId,
      childSessionId,
      recordCount: Object.keys(mapping).length,
      closureFingerprint: parentPrint,
      mapping,
    }
  } catch (error) {
    await markNeedsMigration(labRoot, childSessionId, { parentSessionId, reason: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    if (parentOwned) parent.close()
    childStore.close()
  }
}

/**
 * 读 fork 映射。三态（0.11.0）：
 * - 文件不存在（ENOENT）→ null：确实没有映射，调用方可以按「未迁移」处理；
 * - 读到但解析/结构不符 → { unreadable: true, error }：旁车损坏，不能伪装成「没有映射」；
 * - 正常 → parsed。
 * 旧实现在 catch 里一律返回 null，把损坏、权限、半截 JSON 全折叠成「无映射」，读侧
 * 因此把「解析不了」当成「记录不存在」。调用方必须显式区分三态。
 */
export async function readForkMap(labRoot, sessionId) {
  let raw
  try {
    raw = await readFile(forkMapFileFor(labRoot, sessionId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { unreadable: true, error: error?.code ?? 'read' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { unreadable: true, error: 'parse' }
  }
  if (parsed?.kind !== 'dsh-memory-context-lab/v2/fork-map') return { unreadable: true, error: 'schema' }
  if (!parsed.mapping || typeof parsed.mapping !== 'object') return { unreadable: true, error: 'schema' }
  return parsed
}

/**
 * 子会话是否停在 needs-migration（阻断自动激活）。损坏与不存在同样必须区分：
 * 损坏时返回 { unreadable, error }，由调用方按失败关闭处理。
 */
export async function readNeedsMigration(labRoot, sessionId) {
  let raw
  try {
    raw = await readFile(needsMigrationFileFor(labRoot, sessionId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { unreadable: true, error: error?.code ?? 'read' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { unreadable: true, error: 'parse' }
  }
  if (parsed?.kind !== 'dsh-memory-context-lab/v2/needs-migration') return { unreadable: true, error: 'schema' }
  return parsed
}

export async function markNeedsMigration(labRoot, sessionId, { parentSessionId, reason }) {
  const file = needsMigrationFileFor(labRoot, sessionId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    kind: 'dsh-memory-context-lab/v2/needs-migration',
    schemaVersion: 1,
    childSessionId: sessionId,
    parentSessionId,
    reason,
    at: new Date().toISOString(),
    steps: [
      `1. 在父会话执行 /memory-lab2 fork ${sessionId}（或 /memory-lab2 fork-status 查看父会话闭包预览）。`,
      `2. 若上一次 fork 留下半成品，先执行 /memory-lab2 fork-reset ${sessionId} 清掉再重试。`,
      '3. 确认父会话已完成对账、没有未提交事务、没有停用中的只读账本。',
      '4. 迁移成功后本标记由 fork 流程自动清除；迁移失败请保留父冷库，不要删除。',
      '5. 若宿主无法提供 fork 来源事件，请改用导出/人工迁移，不要用空库继续任务。',
    ],
  }, null, 2)}\n`, 'utf8')
}

/**
 * 清掉一个 fork 半成品子库（仅当带 needs-migration 标记时允许）。
 *
 * 「失败可重试」必须真的有入口：光在错误信息里说「请重试」，而重试路径被
 * 半成品挡住，就是死路。带标记的子会话无法被启用（启用检查拒绝），所以删掉
 * 它不会丢任何用户数据；不带标记一律拒绝。
 */
export async function resetForkChild({ labRoot, childSessionId }) {
  const stuck = await readNeedsMigration(labRoot, childSessionId)
  const exists = await V2SessionStore.exists(labRoot, childSessionId)
  if (!exists) return { reset: false, reason: 'no-child-ledger' }
  if (stuck?.unreadable) {
    throw new EngineV2Error(
      `子会话 ${childSessionId} 的 needs-migration 标记不可读（${stuck.error}）；无法确认它是 fork 半成品，拒绝清理。`,
      { code: 'EFORKMARKERCORRUPT', details: { childSessionId, error: stuck.error } },
    )
  }
  if (!stuck) {
    throw new EngineV2Error(
      `子会话 ${childSessionId} 没有 needs-migration 标记，不是 fork 半成品；拒绝清理（避免删掉真账本）。`,
      { code: 'EINVAL' },
    )
  }
  await rm(v2SessionDirectoryFor(labRoot, childSessionId), { recursive: true, force: true })
  return { reset: true, reason: 'needs-migration' }
}

export async function clearNeedsMigration(labRoot, sessionId) {
  await rm(needsMigrationFileFor(labRoot, sessionId), { force: true })
}

/**
 * 闭包指纹：用于迁移后核对「搬过来的就是父会话那份」。
 * 只对记录 ID + 载荷哈希做哈希，不读正文——指纹不该泄漏内容。
 */
export function closureFingerprint(entries) {
  const lines = entries
    .map((entry) => `${entry.id}:${entry.payload?.hash ?? '-'}`)
    .sort()
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`
}

/**
 * 由父记录派生一条子记录草稿。
 *
 * 关键规则：**只要父记录的载荷可读，就按内容复制**，与保真等级无关。
 * synthesized 记录同样可以带载荷（投影片段、v1 归档指针就是），只按
 * `fidelity === 'verbatim'` 判断会让这些载荷静默留在父库，子库出现
 * 「声明有载荷、实际没有」的记录，随后的指纹核对必然失败——那是搬运有损，
 * 不是父库的问题。真正无载荷的是 `operation.call/result` 这类索引记录
 * （integrity === 'no-payload'），它们照旧不带内容。
 */
function draftFromEntry(entry, loaded) {
  const content = loaded.integrity === 'ok' && typeof loaded.payloadText === 'string' ? loaded.payloadText : null
  const draft = {
    kind: entry.kind,
    seq: entry.seq,
    fidelity: entry.fidelity,
    inline: { ...(entry.inline ?? {}), forkedFrom: entry.id },
    refs: { ...(entry.refs ?? {}) },
  }
  if (content === null) {
    if (entry.payload?.hash) {
      // 父记录声明了载荷却读不出内容：不能悄悄降级成无载荷记录。
      throw new EngineV2Error(
        `父记录 ${entry.id} 声明载荷 ${entry.payload.hash} 但内容不可读（${loaded.integrity}）；fork 中止。`,
        { code: 'EFORKINTEGRITY', details: { recordId: entry.id, integrity: loaded.integrity } },
      )
    }
    return draftRecord(draft)
  }
  return draftRecord({ ...draft, content })
}

/**
 * 未提交事务数。
 *
 * 事务意图文件在提交后**保留**（它就是 WAL 的日志本体，清单只是检查点），
 * 所以不能按文件个数判「未提交」——必须逐条看有没有 `committedAt`。
 * 读不动/读不懂的文件按未提交处理（保守：宁可让 fork 多等一次对账）。
 */
async function countPendingTransactions(directory) {
  let names
  try {
    names = await readdir(path.join(directory, 'transactions'))
  } catch {
    return 0
  }
  let pending = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, 'transactions', name), 'utf8'))
      if (typeof parsed?.committedAt !== 'string') pending += 1
    } catch {
      pending += 1
    }
  }
  return pending
}
