/**
 * 启用阻断后的完整回滚（beta.7 B 组，Y-10 / Y-12）。
 *
 * ## 缺陷
 * 继承审计失败时，旧代码只做了两件事：删进程内记录、把 engine.json 写回 disabled。
 * 漏掉的两件都很难看：
 * - **state.json 仍 enabled:true** → 重试 `on` 时 createV2SessionState 读到 enabled
 *   直接抛 EALREADYON（假「已启用」），而 adopt 又会接管这个会话：用户被卡在
 *   既不能开也不能关的状态里。
 * - **绕过 disposeRecord**（唯一释放 suppressionLease 的地方）→ MdcgClient 对该会话
 *   永久 fallback，真实灵枢静默停止记录，而界面只显示「启用失败」。
 *
 * ## 判据
 * 「启用失败」必须意味着**三处状态全部回到启用前**：进程内记录、engine.json、
 * 会话账本 state.json；并释放抑制租约。任一处残留都会让下一次操作读到互相矛盾的
 * 事实——这正是本组要消灭的形态。
 *
 * ## 不适用条件
 * 只用于**启用过程中**的阻断回滚。正常停用走 disableRecord（它自己维护账本顺序）。
 */

/**
 * 把一次失败的启用完整回滚到启用前状态。
 *
 * @param {object} options
 * @param {Map<string, object>} options.records 进程内会话记录表
 * @param {object} options.record 已建立的 v2 会话记录
 * @param {string} options.sessionId 会话 id
 * @param {string} options.reason 阻断原因（写进账本的停用原因）
 * @param {(sessionId: string, reason: string) => Promise<void>} options.rollbackActivation 写回 engine.json
 * @param {(record: object) => Promise<void>} options.disposeRecord 释放抑制租约等资源
 * @param {(state: object, reason: string) => object} options.disabledStateOf 生成停用态账本
 * @param {(dir: string, state: object) => Promise<void>} options.writeState 写会话账本
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @returns {Promise<{ stateRolledBack: boolean }>} 账本是否成功写回（失败时上层须披露）
 */
export async function rollbackBlockedEnable({
  records,
  record,
  sessionId,
  reason,
  rollbackActivation,
  disposeRecord,
  disabledStateOf,
  writeState,
  logger,
}) {
  records.delete(sessionId)
  await rollbackActivation(sessionId, reason)
  let stateRolledBack = false
  try {
    // 保留 archive（不丢证据），只翻 enabled 与停用原因。
    await writeState(record.directory, disabledStateOf(record.state, reason))
    stateRolledBack = true
  } catch (error) {
    logger?.warn?.(
      'memory-context-lab: 阻断回滚写回 state.json 失败（'
      + (error instanceof Error ? error.message : String(error))
      + '）；该会话账本仍是 enabled:true，重试 on 会报 EALREADYON，请先 /memory-lab off 或清理该会话目录',
    )
  }
  // 释放抑制租约：不释放 = 该会话的真实灵枢自动读写被永久拦截。
  await disposeRecord(record)
  return { stateRolledBack }
}
