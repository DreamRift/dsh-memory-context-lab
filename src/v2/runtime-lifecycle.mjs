/**
 * v2 会话生命周期域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：会话记录的建立与回收、启用/停用、重启对账、恢复与
 * 计划先行联动，共 14 个函数。函数体**逐字搬移**，语义零改动；原本从闭包自由
 * 读取的名字改为显式注入。
 *
 * ## 装配契约
 * `createLifecycleDomain({...})` 收四类依赖：
 *   - **共享注册表**（`records` / `factories` / `activeOperations`）传对象本体，
 *     本域与 runtime 必须看到同一份，不能传副本；
 *   - **engine**：本域在 engine 构造之后装配，engine 的回调只会在装配完成后才被
 *     调用，因此这里直接收引用；
 *   - **同级域的入口**（forget 域四个函数、`compressDepsOf` /
 *     `invalidateLedgerForRestore`）：这些在 runtime 里是函数声明，会被提升，
 *     本域只在调用时才取用；
 *   - **宿主注入项**（`labRoot` / `services` / `logger` / `sessionIdOf` /
 *     设置页默认值 / 计划先行回调 / 语义后端解析器 / `backendPrecheck`）。
 *
 * ## 依赖方向
 * 本域**不**依赖 card 域与 read 域；反向依赖存在（card 域要 `adopt` /
 * `persistCost`，read 域要 `adopt` / `withReadableStore`），所以装配顺序是
 * forget → lifecycle → card → read。
 *
 * ## 不适用条件
 * 本域不持有跨会话缓存：`reconciledAt` 只是本进程内的对账去重表，进程重启即
 * 重建（这是有意的——重启后的第一次 adopt 必须重新对账）。
 */
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { V2_RECEIPT_MARKER, normalizeSettings, restoreGrowth, windowGuardRefuses } from '../core.mjs'
import { describeRestoreSkipReasons } from '../apply.mjs'
import { describeWindowGuardRefusal } from './window-guard-text.mjs'

import { EngineV2Error } from './errors.mjs'
import { createCostLedger } from './cost.mjs'
import { readRecordById } from './readback.mjs'
import { claimV2Engine, disableV2Engine, getEngineRegistry, releaseV2Engine } from './engine.mjs'
import { createV2SessionState, disabledV2State, readV2SessionState, v2SessionDirectoryFor, writeV2SessionState } from './state.mjs'
import { getForgetIndex } from './disposition.mjs'
import { sessionKeyFor } from '../storage.mjs'
import { readNeedsMigration } from './fork.mjs'
import { reconcileVouchers } from './hierarchy-coordinator.mjs'
import { rollbackBlockedEnable } from './enable-rollback.mjs'
import { createCommandChain } from './command-chain.mjs'

export function createLifecycleDomain({
  // 共享注册表（活引用）
  records,
  factories,
  activeOperations,
  engine,
  // 宿主注入
  labRoot,
  services,
  logger,
  sessionIdOf,
  coordinator,
  suppressionUnavailableReason,
  factoryFor,
  receiptTextOf,
  backendPrecheck,
  onEnabled,
  semanticBackend,
  semanticBackendFor,
  semanticBackendClose,
  defaultSettings,
  defaultFullHistory,
  defaultCompressModel,
  defaultShareL2Content,
  // 同级域入口（runtime 里的函数声明，调用时才取用）
  collectForgetEntries,
  forgetNodeBasesOf,
  planWithdrawals,
  withdrawForgottenSurfaces,
  compressDepsOf,
  invalidateLedgerForRestore,
}) {
  /**
   * 崩溃窗口对账：账本已提交、表面撤回/行状态未收口的残差，在下次 adopt 时收敛。
   *
   * 判定完全确定性：受影响回执组的期望墓碑文本逐字节重建后与当前比对——
   * 只有「当前就是原回执」才替换（已撤过、或用户已手工改写过的都不动，如实计数）。
   * 行状态只补标缺失的 forgotten 标记，不重放任何工具副作用。失败时下一次
   * adopt 仍会重试（缓存只在成功后写入）。
   */
  const reconciledAt = new Map()

  function makeRecord({ agent, sessionId, directory, state }) {
    // 抑制状态必须**如实记录**，不能只在拿不到租约时静默（0.13.2 D-04）。
    // 旧实现把 startupError 只打一条 logger.warn，此后全仓无人读取：闸门失败 →
    // coordinator=null → suppressionLease=null → 抑制根本没装上，而 `on` 回执照旧
    // 写死「已抑制」。「抑制 0 次」与「抑制没装上」在用户面前完全无法区分。
    let suppressionLease = null
    let suppressionReason = null
    if (!coordinator) {
      suppressionReason = suppressionUnavailableReason
        ?? '灵枢抑制协调器未装配（dsh-memory 兼容性闸门未通过）'
    } else {
      try {
        suppressionLease = coordinator.acquire(sessionId) ?? null
      } catch (error) {
        suppressionReason = `灵枢抑制租约获取失败：${error instanceof Error ? error.message : String(error)}`
        logger?.warn?.(`memory-context-lab: ${suppressionReason}`)
      }
      if (!suppressionLease && !suppressionReason) {
        suppressionReason = '协调器未授予租约（真实灵枢的自动读写未被拦截）'
      }
    }
    return {
      engineName: 'v2',
      agent,
      sessionId,
      directory,
      state: { ...state, settings: normalizeSettings(state.settings) },
      suppressionLease,
      // 抑制实况：{ available, reason }。命令面、status 与面板都读这一份，
      // 不再各自假设「已经抑制了」。
      suppression: { available: suppressionLease !== null, reason: suppressionReason },
      client: null,
      clientError: null,
      occupancy: null,
      occupancyError: null,
      recallQueryId: null,
      lastAction: null,
      // 工作状态卡注入状态（D1 升级）：最近一次**渲染出的全量卡文本**与已注入
      // 总数、已注入语义键的有界历史。只存内存：重启后丢失即回落「下一张全量卡」，
      // 这是诚实降级（不注入引用了模型从未见过的全量卡的增量卡）。
      workingSetCard: null,
      // S3 三态分离：prepared 未确认载荷（preparedId → 载荷）。只在内存：
      // 宿主确认（confirmInjection）即消费删除；进程重启丢的只是未确认的
      // prepare，下一张卡按「无上卡」语义回落全量（诚实降级）。
      pendingInjections: new Map(),
      // 成本账本：从持久化快照续记，进程内累计；停用与每批降温后落盘。
      cost: createCostLedger(state.cost),
    }
  }

  /**
   * 把成本计数落盘（best-effort）。
   *
   * 记账失败不能让降温或回读失败——但也不能静默：写失败会记一条告警，
   * 并把内存里的计数保留到下次尝试。
   */
  async function persistCost(record) {
    try {
      const counters = record.cost.snapshot()
      record.state = { ...record.state, cost: counters }
      await writeV2SessionState(record.directory, record.state)
    } catch (error) {
      logger?.warn?.(`memory-context-lab: 成本计数落盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function reconcileForgetState(record) {
    if (!record?.directory) return null
    let forgetIndex
    try {
      forgetIndex = await getForgetIndex(record.directory)
    } catch {
      return null // 账本不可读：读面自带告警，这里不再放大。
    }
    const revision = forgetIndex?.revision ?? 0
    if (reconciledAt.get(record.sessionId) === revision) return null
    const targetIds = [...(forgetIndex?.forgotten?.keys() ?? [])]
    if (targetIds.length === 0) {
      reconciledAt.set(record.sessionId, revision)
      return null
    }
    const plan = await planWithdrawals(
      record,
      forgetNodeBasesOf(await collectForgetEntries(record), targetIds),
      targetIds,
    )
    const outcome = await withdrawForgottenSurfaces(
      record,
      { entry: { operationId: null }, targetIds },
      plan,
    )
    reconciledAt.set(record.sessionId, revision)
    if (outcome.withdrawn > 0 || outcome.reconciledRows > 0) {
      logger?.info?.(`memory-context-lab: 遗忘对账收敛（撤回 ${outcome.withdrawn}，补标 ${outcome.reconciledRows}）`)
    }
    return outcome
  }

  async function adopt(agent) {
    const sessionId = sessionIdOf(agent.session)
    if (!sessionId) return null
    const cached = records.get(sessionId)
    if (cached) return cached
    let loaded
    try {
      loaded = await readV2SessionState(labRoot, sessionId)
    } catch (error) {
      // 0.13.2-beta.6 G4（store/p-16 X40）：**损坏不等于未启用**。
      //
      // 旧实现把任何读取异常都吞成 `return null`（＝「本会话没启用」），于是
      // 一个坏掉的状态文件会让 adopt 说「未启用」、`on` 随后在它上面重新初始化，
      // 把既有账本覆盖掉——而 `status` 对同一个文件报的是「损坏，失败关闭」。
      // 同一条事实在两个入口给出相反答案，是这条缺陷的实质。
      // 现在只有「未启用」返回 null；损坏继续向上抛（带 ESTATEDAMAGED），
      // 由命令面按失败关闭报给用户。
      if (error?.code === 'ESTATEDAMAGED') throw error
      logger?.warn?.(`memory-context-lab: 状态文件不可读，本会话按未启用处理：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (!loaded || loaded.state.enabled !== true) return null
    const record = makeRecord({ agent, sessionId, directory: loaded.directory, state: loaded.state })
    records.set(sessionId, record)
    // P2：账本已提交但表面未收口的崩溃窗口，在此收敛（失败不阻塞命令主路径）。
    reconcileForgetState(record).catch(() => {})
    // P3：凭证计划已保存但替换未落表面的崩溃窗口，同路收敛（不阻塞 adopt）。
    reconcileVouchers(await compressDepsOf(record)).catch(() => {})
    return record
  }

  async function disposeRecord(record) {
    try {
      await record.client?.close?.()
    } catch {
      // 关闭失败不阻塞退出。
    }
    try {
      await factories.get(record.sessionId)?.dispose?.()
    } catch {
      // 同上。
    }
    factories.delete(record.sessionId)
    // 释放该会话的检索后端资源（隔离灵枢子进程）。会话停用后不再需要它，
    // 留着会白白常驻一个 Python 进程。失败不阻塞退出。
    try {
      await semanticBackendClose?.({ sessionId: record.sessionId })
    } catch (error) {
      logger?.warn?.(`v2 检索后端释放失败（${record.sessionId}）：${error?.message ?? error}`)
    }
    try {
      record.suppressionLease?.release?.()
    } catch {
      // 租约释放失败由协调器自己的超时兜底。
    }
  }

  // Y-37：此前只把 promise 记进 activeOperations（给停用等待），并未真正排队，
  // 「on 建记录」与「off 拆记录」可以交错。串行逻辑见 v2/command-chain.mjs。
  const commandChain = createCommandChain()

  async function runExclusive(sessionId, work) {
    return commandChain.run(sessionId, work, { track: activeOperations })
  }

  /**
   * 继承历史审计：热投影里的 v2 回执，其记录 ID 必须在本会话可解析。
   *
   * 存在的理由（规范 10.2）：「设置继承不等于历史可读性继承」。fork 出来的子会话
   * 会带着父会话的对话历史（含父 namespace 的回执），但子会话自己的冷库是空的；
   * 模型看到指向不存在证据的回执，比没有回执更糟。启用前查出来并阻断，
   * 而不是等模型真的去读的时候才发现。
   */
  async function auditInheritedArchive(record, { maxCheck = 50 } = {}) {
    const session = record.agent?.session
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    const referenced = []
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      const text = receiptTextOf(event)
      if (text === null || !text.startsWith(V2_RECEIPT_MARKER)) continue
      for (const match of text.matchAll(/\bt\d{8}-r\d{4}\b/g)) referenced.push(match[0])
    }
    const unique = [...new Set(referenced)]
    if (unique.length === 0) return { checked: 0, missing: [], truncated: false }
    const sample = unique.slice(0, maxCheck)
    const missing = []
    const factory = factoryFor(record)
    await factory.withStore(async (store) => {
      for (const id of sample) {
        try {
          await readRecordById(labRoot, record.sessionId, id, { store })
        } catch {
          missing.push(id)
        }
      }
    })
    return { checked: sample.length, missing, truncated: unique.length > sample.length }
  }

  /**
   * 阻断路径的完整回滚（审计 H2）：账本可能已初始化，单独 releaseV2Engine 会
   * 因「已初始化且激活」抛 EENGINEACTIVE，被 .catch 吞掉后恰好留下最坏的
   * 悬空状态（engine.json active + 台账在 + 账本 on）。先正式停用（写
   * disabled）再 release，两步各自的失败都只降级为告警，不掩盖原始错误。
   */
  async function rollbackV2Activation(sessionId, reason) {
    try {
      await disableV2Engine(labRoot, sessionId, reason)
    } catch (error) {
      logger?.warn?.(`memory-context-lab: 阻断回滚时停用失败（${error instanceof Error ? error.message : String(error)}）`)
    }
    try {
      await releaseV2Engine(labRoot, sessionId)
    } catch (error) {
      logger?.warn?.(`memory-context-lab: 阻断回滚时释放声明失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  async function enable(invocation) {
    const agent = invocation.agent
    const sessionId = sessionIdOf(agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝启用 v2。', { code: 'EINVAL' })

    // 1) 引擎所有权：v1 若持有本会话投影则拒绝（双引擎互斥的 v2→v1 方向）。
    const claim = await claimV2Engine(labRoot, sessionId)
    if (!claim.claimed) {
      throw new EngineV2Error(
        'v2 已持有本会话投影，无需重复启用。',
        { code: 'EENGINEACTIVE', details: { holder: 'v2' } },
      )
    }
    // 1a) 检索后端显式指定预检（PR #4 端口二）：强制 lingshu 时，dsh-memory
    //     不在场或后端模块加载失败 → 拒绝启用（EBACKENDUNAVAILABLE），不静默降级。
    //     auto / local-lexical-v1 模式不预检（auto 降级是既有语义，不是错误）。
    if (typeof backendPrecheck === 'function') {
      const precheck = await backendPrecheck()
      if (precheck?.ok === false) {
        await rollbackV2Activation(sessionId, precheck.reason ?? '检索后端预检失败，回滚启用')
        throw new EngineV2Error(precheck.message ?? `检索后端不可用：${precheck.reason ?? '未知原因'}`, { code: precheck.code ?? 'EBACKENDUNAVAILABLE' })
      }
    }
    // 1b) fork 阻断：子会话若停在 needs-migration，不得用空库继续任务（规范 10.2）。
    const stuck = await readNeedsMigration(labRoot, sessionId)
    if (stuck) {
      await rollbackV2Activation(sessionId, '启用前发现 needs-migration 残留，回滚声明')
      throw new EngineV2Error(
        `本会话停在 needs-migration（父会话 ${stuck.parentSessionId ?? '未知'}，原因：${stuck.reason ?? '未记录'}）。\n`
        + `继承历史不等于历史可读；请先完成迁移：\n${(stuck.steps ?? []).join('\n')}`,
        { code: 'ENEEDSMIGRATION', details: { needsMigration: stuck } },
      )
    }
    // 2) 会话账本：创建或重新启用（已启用时 createV2SessionState 抛 EALREADYON）。
    let created
    try {
      created = await createV2SessionState(labRoot, sessionId, normalizeSettings(defaultSettings()))
    } catch (error) {
      // 账本建不起来就完整回滚（账本可能部分写入：停用再释放），避免留下
      // 「已声明但无账本」或「账本 on + 声明 active」的悬空状态。
      await rollbackV2Activation(sessionId, '账本创建失败，回滚启用')
      throw error
    }
    const record = makeRecord({
      agent,
      sessionId,
      directory: created.directory,
      state: created.state,
    })
    // 全历史默认值播种：旧账本（含 off/on 往返）按已有值走；全新账本按设置页默认。
    // 只在值缺失时补，绝不覆盖用户在本会话写下的选择。
    if (record.state.fullHistory === undefined) {
      record.state.fullHistory = defaultFullHistory() === true
      await writeV2SessionState(record.directory, record.state).catch(() => {})
    }
    // 模型模式默认值播种：口径同上（只在缺失时补）。
    if (record.state.compressModel === undefined) {
      record.state.compressModel = defaultCompressModel() === true
      await writeV2SessionState(record.directory, record.state).catch(() => {})
    }
    // T1/F-03：共享正文摘录默认值播种（口径同上：只在缺失时补）。
    if (record.state.shareL2Content === undefined) {
      record.state.shareL2Content = defaultShareL2Content() === true
      await writeV2SessionState(record.directory, record.state).catch(() => {})
    }
    records.set(sessionId, record)
    const warnings = [...(claim.warnings ?? [])]

    // 3) 继承历史审计：热投影里已有 v2 回执但本会话库解析不到 → 阻断启用。
    //    典型场景是 fork：子会话继承父会话对话历史，却没有父会话冷库闭包。
    try {
      const audit = await auditInheritedArchive(record)
      if (audit.missing.length > 0) {
        // 阻断启用 = 完整回滚（Y-10/Y-12）：进程内记录 / engine.json / state.json
        // 三处都回到启用前，并释放抑制租约。判据与实现见 v2/enable-rollback.mjs。
        await rollbackBlockedEnable({
          records,
          record,
          sessionId,
          reason: `继承审计失败：${audit.missing.length} 条回执不可解析`,
          rollbackActivation: rollbackV2Activation,
          disposeRecord,
          disabledStateOf: disabledV2State,
          writeState: writeV2SessionState,
          logger,
        })
        throw new EngineV2Error(
          `本会话热投影里有 ${audit.missing.length} 条 v2 回执指向本会话冷库中不存在的记录`
          + `${audit.truncated ? '（仅抽查了前 50 条）' : ''}：${audit.missing.slice(0, 5).join('、')}\n`
          + '这通常意味着会话是从父会话 fork 而来但历史尚未迁移。\n'
          + `请先迁移：/memory-lab fork ${sessionId} 后重试。`,
          { code: 'EINHERITEDUNREADABLE', details: audit },
        )
      }
      if (audit.checked > 0) warnings.push(`继承审计：${audit.checked} 条回执在本会话可解析`)
    } catch (error) {
      if (error instanceof EngineV2Error) throw error
      // 审计本身失败（例如库打不开）不阻断启用，但必须留下告警而不是静默放过。
      warnings.push(`继承审计未完成：${error instanceof Error ? error.message : String(error)}`)
    }

    if (warnings.length) logger?.warn?.(`memory-context-lab: ${warnings.join('；')}`)
    // 计划先行联动（由 index.mjs 注入）：启用成功且开关为开、会话全新时进入计划模式。
    //
    // 0.12.0 P1-1：`index.mjs` 注入的 onEnabled **返回同步对象**（plan-first 的
    // `enterIfFresh` 是同步函数），旧写法 `onEnabled?.(agent)?.catch(...)` 在同步
    // 返回值上访问 `.catch` 是 undefined → TypeError。而这段代码在 `enable()` 尾部、
    // 记录与状态**已经落盘之后**且不在 try 内：命令显示失败，引擎其实已启用——
    // 「失败关闭」在这里完全没生效。现在同步与异步都接，抛错一律降级为提示。
    let planNote = null
    let planNoteFailed = false
    try {
      const note = onEnabled?.(agent)
      if (note && typeof note.then === 'function') {
        // 异步分支的 rejection 同样要降级为提示（并留下「计划先行未生效」），
        // 不能静默吞成 null —— 那会让回执看起来一切正常。
        planNote = (await note.catch(() => { planNoteFailed = true; return null })) ?? null
      } else {
        planNote = note ?? null
      }
    } catch (error) {
      planNoteFailed = true
      logger?.warn?.(`memory-context-lab: 计划先行联动失败（引擎已启用，计划模式未生效）：${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      kind: 'success',
      text: `已启用 v2 引擎（全历史按需记忆化）。\n隔离根：${created.directory}\n`
        + (record.suppression.available
          ? '本会话对真实灵枢的自动读写已抑制。\n'
          : `抑制未启用（${record.suppression.reason}）：真实灵枢的自动读写**未被拦截**，实验文本可能写入正式 dsh-memory 根。\n`)
        + (warnings.length ? `告警：${warnings.join('；')}` : '')
        + (planNote ? `\n${planNote.text}` : '')
        + (planNoteFailed ? '\n计划先行未生效：联动回调抛错（引擎已启用，降温照常；可稍后 `/memory-lab status` 复核）。' : ''),
    }
  }

  /**
   * 停用一个会话的 v2：先恢复投影，再置停用、清引擎声明。
   *
   * 以 record 为中心（而不是以命令调用为中心），因为归档清理路径只拿得到
   * sessionId，拿不到命令 invocation，但两者必须是同一条停用语义。
   */
  async function disableRecord(record, sessionId, reason) {
    const lines = []
    let restored = 0
    let before = 0
    let windowGuardRefusal = null
    // Q-01：两个值在 `if (record)` 内算出、在回执首行（块外）还要用，故提到顶层。
    let autoRestore = true
    let pendingCount = 0

    if (record) {
      // 0) 停用意图先落盘（Y-26）：旧顺序崩溃时留下「表面已回原文、账本仍 enabled:true」，
      // 重启后 on 报假 EALREADYON 且 pendingReceipts 找不到回执。先写停用再恢复。
      const disabledIntent = disabledV2State(record.state, reason)
      await writeV2SessionState(record.directory, disabledIntent)
      record.state = disabledIntent

      // 0) 窗口守卫：恢复会让组装输入超窗时跳过恢复、照常停用（原文留冷库并给出路）。
      // restore-skipped 行同样走守卫。Q-01：autoRestore 只决定要不要恢复，不决定要不要守卫。
      const settings = engine.settingsOf(record)
      // 缺失视为开（与 normalizeSettings 的默认一致）：旧账本没有这个字段时按默认恢复。
      autoRestore = settings?.autoRestore !== false
      const pendingRows = [...engine.pendingReceipts(record), ...engine.restoreSkippedReceipts(record)]
      pendingCount = pendingRows.length
      if (pendingCount > 0) {
        try {
          const occupancy = await engine.measureOccupancy(record, undefined)
          const growth = restoreGrowth(pendingRows, {
            assembledTokens: occupancy.host.assembledTokens,
            contextWindow: occupancy.host.contextWindow,
          })
          // G3：windowGuardRefuses 是唯一判据，unknown 与 true 同样拒绝（不靠字符串真值性）。
          if (windowGuardRefuses(growth)) {
            windowGuardRefusal = {
              total: growth.total,
              heldByReceipts: growth.heldByReceipts,
              assembled: occupancy.host.assembledTokens,
              window: occupancy.host.contextWindow,
              // 判定不了时如实说「判不了」，不要让回执读起来像「确实超了」。
              undetermined: growth.overflow === 'unknown',
              unknownReasons: growth.unknownReasons,
            }
          }
        } catch (error) {
          // G3：测量失败 ≠ 没有守卫——落成 undetermined 拒绝结论（判不了不放行）。
          logger?.warn?.(`memory-context-lab: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
          windowGuardRefusal = {
            total: Number.NaN,
            heldByReceipts: 0,
            assembled: null, window: null,
            undetermined: true,
            unknownReasons: [`占用不可判定：${error instanceof Error ? error.message : String(error)}`],
          }
        }
      }

      // 1) 按设置决定是否恢复（Q-01）：`autoRestore` 关时**只停用、不恢复**，
      //    原文留在冷库并给出两条出路。文档（docs/降温模式.md 的「停止」节）一直
      //    这么写，代码此前没照做。
      if (!autoRestore) {
        if (pendingCount > 0) {
          lines.push(
            `按设置「停用时恢复原文」为关：本次只停用、不恢复，${pendingCount} 段原文仍留在冷库里（历史与载荷按只读保留，旧记录 ID 仍可回读）。`,
            '要取回原文：先 `/memory-lab on` 重新启用，再 `/memory-lab restore` 整批恢复；或直接丢弃冷库：`/memory-lab clean confirm delete-session`。',
          )
        } else {
          lines.push('按设置「停用时恢复原文」为关：本次只停用。本会话没有待恢复的原文。')
        }
        // 守卫的结论照样披露：用户随后打开开关（或直接 restore）时会撞上同一个上限。
        if (windowGuardRefusal) {
          const growth = windowGuardRefusal.total - (windowGuardRefusal.heldByReceipts ?? 0)
          lines.push(`注意：${describeWindowGuardRefusal(windowGuardRefusal, growth)}，恢复前请先缩小上下文。`)
        }
      } else if (!windowGuardRefusal) {
        try {
          const outcome = await engine.runRestore(record)
          restored = outcome?.restored ?? 0
          before = outcome?.before ?? 0
          // 0.12.0 P0-2：恢复成功的区间已回活动面，读取账本里「已归档」的标记随之失效。
          await invalidateLedgerForRestore(record, outcome)
          // P0-2：停用回执必须如实报告仍未恢复的行——它们的原文只在冷库，
          // 停用后冷库按只读保留，旧记录 ID 仍可回读，但不能宣称「全部恢复」。
          const stillSkipped = outcome?.stillSkipped ?? 0
          if (stillSkipped > 0) {
            // N-07：回执必须**给出原因**。旧文案「原因见上」的上面什么都没有，
            // 用户唯一能看到的解释是一句空指向——这正是「恢复不完全是什么情况」
            // 必须来问人的原因。
            const why = describeRestoreSkipReasons(outcome?.skippedReasons)
            lines.push(`仍有 ${stillSkipped} 段原文未恢复（restore 跳过）${why ? `，原因：${why}` : '（原因未取得，可 /memory-lab status 复核）。'}它们的正文仍在冷库里，历史与载荷按只读保留，旧记录 ID 仍可回读。`)
          }
          // P2：软遗忘的行不会随 off 恢复（可见性由 disposition 账本持有，
          // 与引擎开关解耦）；停用回执必须如实披露这段「不在恢复范围内」。
          const forgottenCount = outcome?.forgotten ?? 0
          if (forgottenCount > 0) {
            lines.push(`另有 ${forgottenCount} 段已软遗忘未恢复：off 只停用引擎，不改变遗忘状态；如需恢复可见性，先重新启用后用 /memory-lab forget undo <操作ID>。`)
          }
        } catch (error) {
          // 恢复失败不静默：仍继续停用，但把失败写进回执文本，且不宣称已恢复。
          lines.push(`恢复未完成：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        const growth = windowGuardRefusal.total - (windowGuardRefusal.heldByReceipts ?? 0)
        lines.push(
          `停用了降温，但${describeWindowGuardRefusal(windowGuardRefusal, growth)}，`,
          '因此**没有**恢复，原文仍在冷库里。要取回原文，请先缩小上下文，或直接丢弃冷库：',
          '  /memory-lab clean confirm delete-session',
        )
      }
      record.state = disabledV2State(record.state, reason) // 计数变化再落一次（幂等）
      await writeV2SessionState(record.directory, record.state)
      await disposeRecord(record)
      records.delete(sessionId)
    } else {
      lines.push('本会话没有活动的 v2 记录（可能已停用）。')
    }

    // 2) 引擎所有权：置 disabled 并清台账声明。
    const outcome = await disableV2Engine(labRoot, sessionId, reason)
    if (outcome.warnings?.length) lines.push(...outcome.warnings)

    // 首行必须与**实际发生的事**一致（Q-01）：三种结局各有各的写法，
    // 不得在「按设置未恢复」时照样印「恢复 N/M 段」。
    lines.unshift(
      !autoRestore
        ? (pendingCount > 0
          ? `已停用 v2 引擎，按设置未恢复原文（${pendingCount} 段仍在冷库，见下）。历史与载荷按只读保留，旧记录 ID 仍可回读。`
          : '已停用 v2 引擎，按设置未恢复原文（本会话没有待恢复的原文）。')
        : windowGuardRefusal
          ? '已停用 v2 引擎，未恢复原文（窗口守卫拒绝，见下）。历史与载荷按只读保留，旧记录 ID 仍可回读。'
          : `已停用 v2 引擎。恢复 ${restored}/${before} 段原文；`
            + '历史与载荷按只读保留，旧记录 ID 仍可回读。',
    )
    return { kind: 'success', text: lines.join('\n'), restored, before }
  }

  async function disable(invocation, reason) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝停用 v2。', { code: 'EINVAL' })
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    return disableRecord(record, sessionId, reason)
  }

  /**
   * 只按 sessionId 停用（归档清理路径）。
   *
   * 会话已被归档、拿不到 Agent 时返回 skipped：没有活动面可恢复，此时删数据
   * 才是错的——回执仍指向冷库，留着它才对。
   */
  async function disableById(sessionId, reason) {
    const record = records.get(sessionId) ?? await adoptById(sessionId)
    if (!record) return { restored: 0, before: 0, skipped: true }
    return disableRecord(record, sessionId, reason)
  }

  async function adoptById(sessionId) {
    const agents = services?.get?.('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : null
    if (!agent) return null
    return adopt(agent)
  }

  /**
   * `/memory-lab restore`（B2）：不停用引擎，把全部可恢复的回执恢复回原文。
   *
   * 与 `off` 的区别只在「不停用」：恢复管线复用同一套 `engine.runRestore`
   * （逐回执校验冷节点与表层一致性，失败行如实逐条说明并保持可按 ID 回读）。
   * 面板的「恢复原文」在 v2 会话改发本命令，不再硬编码 v1 的 `/memory-lab restore`
   * （后者在 v1 adopt 为 null 时会误报「未启用」，见会话 c896f803 的排查）。
   */
  async function restoreOnly(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝恢复。', { code: 'EINVAL' })
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) {
      return {
        kind: 'error',
        text: 'v2 引擎在本会话未启用，没有可整批恢复的 v2 回执。\n'
          + '若此前启用过又停用：回执仍在会话日志里，单段原文可用 /memory-lab read <ID> 回读（停用后旧 ID 仍可解析）。',
      }
    }
    // G3（对抗审查 finding 2）：整批 restore 是用户最直接的取回路径，此前**完全
    // 不走窗口守卫**——off 与 set fullhistory off 两条路径都会拒绝，唯独这条不会，
    // 于是三态守卫可以被绕过（恢复一堆原文直接顶穿模型窗口）。这里复用同一套
    // windowGuardRefuses 判据：拒绝时如实说「没恢复」并给出缩上下文的路。
    const pendingRows = [...engine.pendingReceipts(record), ...engine.restoreSkippedReceipts(record)]
    let refusal = null
    if (pendingRows.length > 0) {
      try {
        const occupancy = await engine.measureOccupancy(record, undefined)
        const growth = restoreGrowth(pendingRows, {
          assembledTokens: occupancy.host.assembledTokens,
          contextWindow: occupancy.host.contextWindow,
        })
        if (windowGuardRefuses(growth)) {
          refusal = {
            total: growth.total,
            heldByReceipts: growth.heldByReceipts,
            assembled: occupancy.host.assembledTokens,
            window: occupancy.host.contextWindow,
            undetermined: growth.overflow === 'unknown',
            unknownReasons: growth.unknownReasons,
          }
        }
      } catch (error) {
        // 与 disableRecord 同口径：测量失败 = 判不了 = 拒绝，不是「没有守卫」。
        logger?.warn?.(`memory-context-lab: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
        refusal = {
          total: Number.NaN,
          heldByReceipts: 0,
          assembled: null,
          window: null,
          undetermined: true,
          unknownReasons: [`占用不可判定：${error instanceof Error ? error.message : String(error)}`],
        }
      }
    }
    if (refusal) {
      const growth = refusal.total - (refusal.heldByReceipts ?? 0)
      return {
        kind: 'error',
        text: `没有恢复：${describeWindowGuardRefusal(refusal, growth)}。`
          + `\n${pendingRows.length} 段原文仍在冷库（引擎保持启用）。要取回：先缩小上下文再重试 /memory-lab restore，或直接丢弃冷库：/memory-lab clean confirm delete-session。`,
        restored: 0,
        before: pendingRows.length,
      }
    }
    const outcome = await engine.runRestore(record)
    return {
      kind: 'success',
      text: `${outcome.text}\n引擎保持启用（本次不停用）；单段回读用 /memory-lab read <ID>，整批恢复并停用用 /memory-lab off。`,
      restored: outcome.restored,
      before: outcome.before,
    }
  }

  /**
   * `/memory-lab clean confirm delete-session`：丢弃本会话的隔离根。
   *
   * 为什么存在：停用时若恢复会让组装输入超出模型窗口，引擎会**拒绝恢复**并让原文
   * 留在冷库——那时用户唯一的出路就是丢弃冷库。停用回执与 `set fullhistory off`
   * 的提示都指向这条命令，所以它必须是真能执行的，不能只是文案。
   *
   * 安全口径：
   *   - 必须显式带 `confirm delete-session`（两道词），少一个只回用法；
   *   - 引擎仍启用时**拒绝**（先 `off`）——活动账本被删会让投影里的回执指向空冷库；
   *   - 只删本会话自己的隔离根，不碰 DSH 会话日志、命令审计与真实灵枢根。
   */
  /**
   * 「引擎是否仍启用」的三源判定（0.13.2 D-02）：进程内记录 ∨ 磁盘 enabled ∨ engine.json 激活。
   *
   * 任一成立即拒绝；任何一处**无法判定**也拒绝（失败关闭）——「证明不了已停用」不等于
   * 「已停用」，而这一步的代价是永久删除原文。
   */
  async function cleanGuardOf(sessionId) {
    if (records.get(sessionId)) return { cleared: false, reason: '本进程内仍有活动的 v2 记录' }
    try {
      const onDisk = await readV2SessionState(labRoot, sessionId)
      if (onDisk?.state?.enabled === true) return { cleared: false, reason: '磁盘账本（state.json）仍写着 enabled=true' }
    } catch (error) {
      return { cleared: false, reason: `状态文件不可读（${error instanceof Error ? error.message : String(error)}），无法证明已停用` }
    }
    try {
      const registry = getEngineRegistry(labRoot, sessionId)
      if (registry.damaged) return { cleared: false, reason: 'engine.json 不可读，无法确认引擎所有权' }
      if (registry.holder === 'v2') return { cleared: false, reason: 'engine.json 仍处于激活状态（disabled 为空）' }
    } catch (error) {
      return { cleared: false, reason: `引擎声明不可判定（${error instanceof Error ? error.message : String(error)}）` }
    }
    return { cleared: true, reason: '' }
  }

  /**
   * 删除隔离根之前，把 state.json / engine.json 备份到 `<labRoot>/v2/quarantine/` 下。
   *
   * 备份必须放在**被删目录之外**：放在会话根里会被同一次 `rm -rf` 一起删掉，等于没留。
   * 返回备份目录（无可备份文件时返回 null）。
   */
  async function backupSessionMeta(sessionId, directory) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(path.resolve(labRoot), 'v2', 'quarantine', `deleted-session-${sessionKeyFor(sessionId)}-${stamp}`)
    let copied = 0
    for (const name of ['state.json', 'engine.json']) {
      try {
        await mkdir(target, { recursive: true })
        await copyFile(path.join(directory, name), path.join(target, name))
        copied += 1
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return copied > 0 ? target : null
  }

  async function cleanSession(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!sessionId) return { kind: 'error', text: '无法确定会话 ID，拒绝清理。' }
    if (args.length !== 2 || args[0] !== 'confirm' || args[1] !== 'delete-session') {
      return {
        kind: 'error',
        text: '用法：`/memory-lab clean confirm delete-session`。'
          + '这会**永久删除**本会话的隔离冷库（已归档原文随之丢失），不可撤销。',
      }
    }
    // 守卫必须查**三处**（0.13.2 D-02）：只查进程内 `records` 时，DSH 重启后
    // `records` 为空而磁盘上 state.json 仍 enabled=true、engine.json 仍 disabled:null、
    // 会话日志里的 v2 回执仍指向这批记录——三者都在，守卫却看不到任何一个，于是
    // `rm -rf` 整个隔离根：原文永久不可读，连「这里曾经启用过」都查不出来。
    const guard = await cleanGuardOf(sessionId)
    if (!guard.cleared) {
      return {
        kind: 'error',
        text: `本会话的记忆上下文仍处于启用状态，拒绝删除冷库。\n`
          + `依据：${guard.reason}\n`
          + '先 `/memory-lab off` 停用（它会尽量恢复原文），再执行本命令。',
      }
    }
    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    // 删除前把状态与引擎声明备份到隔离区：即使误删，也留下一条取证痕迹
    // （「这里曾经启用过、设置是什么、何时停用」）。备份失败不阻断删除。
    const backup = await backupSessionMeta(sessionId, directory).catch(() => null)
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      return {
        kind: 'error',
        text: `删除隔离根失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return {
      kind: 'success',
      text: [
        '已删除本会话的隔离冷库：' + directory,
        backup ? `状态与引擎声明已备份：${backup}` : '（状态文件备份失败，未留取证副本）',
        '会话日志与命令审计未改动；插件从不删除它们（那是宿主的 append-only 记录）。',
      ].join('\n'),
    }
  }

  return {
    persistCost,
    adopt,
    disposeRecord,
    runExclusive,
    enable,
    disable,
    disableById,
    adoptById,
    restoreOnly,
    cleanSession,
  }
}