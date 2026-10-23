/**
 * 会话级命令链（Y-37）。
 *
 * 为什么单独成模块：runtime-lifecycle 已经有「停用等待」（activeOperations），
 * 但那个集合只保证**停用时会等**，不保证**两个命令不同时跑**。两者职责不同，
 * 混在一个文件里既容易再次混淆，也顶破单文件行数预算。
 *
 * 语义：
 *   - 同一 sessionId 的命令串行（后到者等前一个结束）；
 *   - 不同 sessionId 互不影响；
 *   - 前一个命令抛错不会断链（链上记录的是已消化的 promise）。
 */

export function createCommandChain() {
  const tails = new Map()

  return {
    async run(sessionId, work, { track = null } = {}) {
      const previous = tails.get(sessionId) ?? Promise.resolve()
      const pending = previous.then(() => work(), () => work())
      // 链上放「已消化」的版本：调用方失败不影响下一个排队者。
      const settled = pending.then(() => undefined, () => undefined)
      tails.set(sessionId, settled)
      track?.add?.(pending)
      try {
        return await pending
      } finally {
        track?.delete?.(pending)
        // 只有自己还是链尾时才回收，避免抹掉后来者的队列。
        if (tails.get(sessionId) === settled) tails.delete(sessionId)
      }
    },
    /** 当前仍在排队的会话数（诊断用，不参与判定）。 */
    size() {
      return tails.size
    },
  }
}
