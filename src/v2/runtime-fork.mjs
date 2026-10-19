/**
 * v2 fork 迁移域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：父会话闭包向子会话的只读预览、半成品清理与迁移提交。
 * 函数体逐字搬移，语义零改动。
 *
 * ## 装配契约
 * `createForkDomain({ labRoot, sessionIdOf })`：本域只碰磁盘与路径推导，
 * 不需要 records 注册表，也不需要 engine——fork 不改变父会话的投影。
 *
 * ## 不适用条件
 * 迁移完成后的接管在**子会话**里发生（子会话执行 `/memory-lab on`），
 * 本域不负责子会话的启用。
 */
import { EngineV2Error } from './errors.mjs'
import { executeForkClosure, planForkClosure, readNeedsMigration, resetForkChild } from './fork.mjs'

export function createForkDomain({
  labRoot,
  sessionIdOf,
}) {
  /**
   * `/memory-lab fork-status`：只读预览本会话闭包能不能搬、有多大。
   *
   * 不写任何文件；借活动句柄读（同一目录只允许一个句柄，重开会 EOPEN）。
   */
  async function forkStatus(invocation) {
    const parentSessionId = sessionIdOf(invocation.agent.session)
    try {
      const plan = await planForkClosure({ labRoot, parentSessionId })
      if (!plan.exists) {
        return { kind: 'success', text: '本会话没有 v2 账本，没有可继承闭包（fork 会以 EFORKNOPARENT 拒绝）。' }
      }
      const lines = [
        `父会话 ${parentSessionId}：${plan.recordCount} 条记录，载荷 ${plan.payloadBytes} 字节，未提交事务 ${plan.pendingTransactions} 个。`,
        `闭包指纹 ${plan.closureFingerprint ?? '不可计算'}。`,
      ]
      if (plan.blocked.length > 0) lines.push(`不可迁移：${plan.blocked.join('；')}`)
      else lines.push('可以迁移：`/memory-lab fork <子会话ID>`。')
      if (plan.warnings.length > 0) lines.push(`告警（不阻断）：${plan.warnings.join('；')}`)
      return { kind: 'success', text: lines.join('\n') }
    } catch (error) {
      return { kind: 'error', text: `fork-status 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async function forkReset(invocation, args) {
    const childSessionId = String(args[0] ?? '').trim()
    if (!childSessionId) {
      return { kind: 'error', text: '用法：`/memory-lab fork-reset <子会话ID>`（只清带 needs-migration 标记的半成品）。' }
    }
    try {
      const result = await resetForkChild({ labRoot, childSessionId })
      if (!result.reset) {
        return { kind: 'success', text: `子会话 ${childSessionId} 没有 v2 账本，无需清理。` }
      }
      return { kind: 'success', text: `已清掉子会话 ${childSessionId} 的 fork 半成品；现在可以重新执行 fork。` }
    } catch (error) {
      return { kind: 'error', text: `fork-reset 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * `/memory-lab fork <子会话ID>`：把本会话闭包复制进子会话隔离根。
   *
   * 只写**尚未建档**的子会话；ID 逐字保留；父库只读不改。
   */
  async function forkTo(invocation, args) {
    const parentSessionId = sessionIdOf(invocation.agent.session)
    const childSessionId = String(args[0] ?? '').trim()
    if (!childSessionId) {
      return { kind: 'error', text: '用法：`/memory-lab fork <子会话ID>`（子会话必须尚未建立 v2 账本）。' }
    }
    if (childSessionId === parentSessionId) {
      return { kind: 'error', text: '子会话不能是当前会话。' }
    }
    try {
      const result = await executeForkClosure({ labRoot, parentSessionId, childSessionId })
      return { kind: 'success', text: [
        `fork 完成：${result.recordCount} 条记录复制进子会话 ${childSessionId}。`,
        `闭包指纹 ${result.closureFingerprint}（父子一致才落盘）。`,
        '记录 ID 逐字保留：子会话可直接按旧 ID 回读；父库未被改动。',
        `子会话尚未启用 v2；在子会话执行 /memory-lab on 接管投影。`,
      ].join('\n') }
    } catch (error) {
      const code = error instanceof EngineV2Error ? error.code : 'EFORK'
      // 只有**真的**留下了 needs-migration 标记才这么说。fork 在写子库之前就失败
      // （父库不可读、父闭包被阻断）时子会话目录根本不存在，报「已标记」是谎报，
      // 会把用户指向一个不存在的恢复入口。
      let marker = null
      try { marker = await readNeedsMigration(labRoot, childSessionId) } catch { marker = null }
      return {
        kind: 'error',
        text: [
          `fork 未完成（${code}）：${error instanceof Error ? error.message : String(error)}`,
          marker
            ? `子会话已标记 needs-migration；用 /memory-lab fork-reset ${childSessionId} 清掉半成品后重试。`
            : '子会话未被改动（未留下标记），处理完上面的原因后可直接重试。',
        ].filter(Boolean).join('\n'),
      }
    }
  }

  return {
    forkStatus,
    forkReset,
    forkTo,
  }
}
