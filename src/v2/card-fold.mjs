/**
 * S3 卡片组折叠（0.10.1）：把活动面上**连续的插件工作卡组**合并成单条折叠回执。
 *
 * H0 裁定后的 surface replace 路线：宿主没有 request-local 投影 seam，有界治理
 * 走既有表层替换通道。插件自己的工作卡（working-set/recall/回执凭证）在 pre-step
 * 尾部追加，天然形成连续卡组——把它们折叠成一条恒定大小的回执，是卡节点数的
 * 局部收益优化（不作全局硬上界证明，方案 §6 原文裁决保持不变）。
 *
 * 两条铁律（红例锁死）：
 * 1. 身份判定只认 source.form / 回执标记——不看内容前缀，人类手打的相似文本
 *    绝不入组（S3-F5）。
 * 2. 任何非卡节点都是断组边界。折叠区间两端必须是卡节点，区间内不得含
 *    assistant / tool-result / 人类 user / system 节点——「跨非卡区间整段
 *    replace 会吞助手消息」被方案 §6 明确禁止（S3-F2/F3）。
 *
 * 本模块纯函数、无 IO：输入是活动面节点视图（{ seq, type, sourceForm, text }），
 * 输出是确定性折叠计划，提交由调用方走 appendVoucherMessage 同款 surfaceOp.replace。
 */
import { buildProjectionHeader, FOLD_RECEIPT_MARKER, V2_RECEIPT_MARKER } from '../core.mjs'
import { estimateTokensOf, estimateTokensOfBytes } from './budget.mjs'

/**
 * 折叠卡身份的来源形态：**只有工作状态卡**（与 PLUGIN_SOURCE_FORMS 写入端一致）。
 *
 * 0.12.0 P0-6（G1）：`recall` 曾经算作卡形态，于是同一步的回注包（prepend）与
 * 工作卡（append）两条相邻 user/message 正好满足 `minRun=2`，下一次归档就被折成
 * 一条回执——**刚读回的证据从投影消失**，模型只能再读一次。这是自激循环的另一半：
 * 不是重复注入，而是注入即被折掉。
 *
 * 现在 `recall` 是**断组边界**：回注包的生命周期交给归档管线（净占用闸门），
 * 不由折叠管理。折叠只治理插件自己的工作状态卡与回执凭证。
 */
export const CARD_FOLD_FORMS = Object.freeze(['working-set', 'working-state'])

/** 回注包的来源形态：明确登记为「不参与折叠」的卡形态（断组边界，供测试与文档引用）。 */
export const CARD_FOLD_EXCLUDED_FORMS = Object.freeze(['recall'])

export const CARD_FOLD_DEFAULTS = Object.freeze({
  /** 组长下限：单卡不折叠（折叠一张卡没有净收益，还多一次 replace 事件）。 */
  minRun: 2,
  /** 组长上限：一次 replace 的 sourceEventSeqs 与回执行数保持有界。 */
  maxRun: 8,
})

/**
 * 卡片净占用上限（字符）。0.12.0 P0-4。
 *
 * 实测 107 张工作卡、75,011 字符（占工具结果字符 11.4%），0 张被归档：搭车归档的
 * 前提是「本批 countable 够批」，countable 不够批时卡片就一直堆着。上界必须按
 * **字符**算而不是按条数：`MIN_OPERATION_CHARS = 1200` 对 span 同样生效，短卡永远
 * 进不了候选（G3）。
 */
export const CARD_NET_CHAR_CAP = 4000

/**
 * 活动面上插件卡节点的净占用（字符）与最新一张工作卡的 seq。
 *
 * 「最新一张永远保护」不是优化而是语义：它是模型当前能看到的工作状态，
 * 折掉它等于把状态面清零，而折叠回执只说「有 N 张卡」。
 */
export function cardOccupancyOf(nodes) {
  const ordered = [...(nodes ?? [])].filter((node) => Number.isInteger(node?.seq)).sort((a, b) => a.seq - b.seq)
  let chars = 0
  let count = 0
  let newestWorkingStateSeq = null
  for (const node of ordered) {
    if (!isCardNode(node)) continue
    chars += typeof node.text === 'string' ? node.text.length : 0
    count += 1
    if (node.sourceForm === 'working-set' || node.sourceForm === 'working-state') newestWorkingStateSeq = node.seq
  }
  return { chars, count, newestWorkingStateSeq, overCap: chars > CARD_NET_CHAR_CAP }
}

/**
 * 一个节点是不是插件工作卡。只认身份标记：sourceForm ∈ CARD_FOLD_FORMS，
 * 或正文以 V2_RECEIPT_MARKER 开头的归档回执/凭证（与 agg-voucher 的判定同源，
 * 但那里收窄到 memory-lab2-surface 形态；这里收窄到卡形态集）。
 *
 * 回注包（sourceForm === 'recall'）**不是**卡：它是当轮证据，折掉它等于让「取回」
 * 这条路径自我否定（0.12.0 P0-6）。
 */
export function isCardNode(node) {
  if (!node || node.type !== 'user/message') return false
  if (typeof node.sourceForm === 'string' && CARD_FOLD_FORMS.includes(node.sourceForm)) return true
  return typeof node.text === 'string' && node.text.startsWith(V2_RECEIPT_MARKER)
}

/**
 * 规划折叠。返回 { plans, runs }：
 * - runs 是全部连续卡组（含太短的），供诊断与计数；
 * - plans 是可提交计划：组长 ≥ minRun 才折叠，超长按 maxRun 切片，
 *   **尾片低于 minRun 时整片丢弃**——残片折叠一次的回执开销不小于残片本身，
 *   且切出的残片会让「卡节点数有界」多一个例外档。
 *
 * 切片策略保证计划不重叠且保序：每片是组的连续前缀切片，按 seq 升序输出。
 */
export function planCardFolds(nodes, {
  minRun = CARD_FOLD_DEFAULTS.minRun,
  maxRun = CARD_FOLD_DEFAULTS.maxRun,
  /** 永不折叠的节点 seq（P0-4：最新一张工作状态卡）。它们同时是断组边界。 */
  protectSeqs = [],
} = {}) {
  const protectedSet = new Set((Array.isArray(protectSeqs) ? protectSeqs : []).filter(Number.isInteger))
  // 顺序以**活动面顺序**为准（调用方传入的就是 surface.nodes 的顺序），不再按 seq
  // 排序：replace 事件拿到的 seq 比它左边仍在面上的节点大，按 seq 排序会把折叠回执
  // 挪到被保留的卡后面，于是下一轮把「断组边界」读成卡、把卡读成边界（0.12.0 实测：
  // 每轮注 2 张卡时卡数不收敛）。surface 顺序是权威，折叠计划也要求保序。
  const ordered = [...(nodes ?? [])].filter((node) => Number.isInteger(node?.seq))
  const min = Number.isInteger(minRun) && minRun >= 1 ? minRun : CARD_FOLD_DEFAULTS.minRun
  const max = Number.isInteger(maxRun) && maxRun >= min ? maxRun : CARD_FOLD_DEFAULTS.maxRun

  const runs = []
  let current = []
  for (const node of ordered) {
    if (isCardNode(node) && !protectedSet.has(node.seq)) {
      current.push(node)
    } else {
      // 任何非卡节点都是断组边界：assistant、tool/result、人类 user、system、
      // 以及任何未知类型。折叠区间绝不允许跨过它们。
      if (current.length > 0) runs.push(current)
      current = []
    }
  }
  if (current.length > 0) runs.push(current)

  const plans = []
  for (const run of runs) {
    if (run.length < min) continue
    for (let offset = 0; offset + min <= run.length; offset += max) {
      const chunk = run.slice(offset, Math.min(offset + max, run.length))
      // 尾片低于 minRun：整片丢弃，不出残片计划。
      if (chunk.length < min) continue
      const memberSeqs = chunk.map((node) => node.seq)
      const startSeq = memberSeqs[0]
      const endSeq = memberSeqs[memberSeqs.length - 1]
      const forms = chunk.map((node) => node.sourceForm ?? 'receipt')
      // P0-5：折叠回执同样要声明率与失真。字符数来自成员卡的**渲染文本长度**，
      // token 用与归档同一把尺子（estimateTokensOf），不新增统计口径。
      const chars = chunk.reduce((sum, node) => sum + (typeof node.text === 'string' ? node.text.length : 0), 0)
      // token 估算走字节口径（中文 1 字 ≈ 3 字节），与归档侧 estimateTokensOf 同源。
      const bytes = chunk.reduce((sum, node) => sum + (typeof node.text === 'string' ? Buffer.byteLength(node.text, 'utf8') : 0), 0)
      plans.push({
        startSeq,
        endSeq,
        memberSeqs,
        forms,
        chars,
        tokens: estimateTokensOfBytes(bytes),
        text: renderFoldReceipt({ startSeq, endSeq, memberSeqs, forms, chars, tokens: estimateTokensOfBytes(bytes) }),
      })
    }
  }
  return { plans, runs: runs.map((run) => run.map((node) => node.seq)) }
}

/**
 * 折叠回执文本：纯函数、逐字节确定、无时间戳（前缀缓存安全）。
 *
 * 只报结构事实：成员范围、张数、形态分布、原文去向。不宣称「内容已理解」，
 * 不复述卡片正文——模型需要时可按记录 ID 回读，那是回读路径的事。
 */
export function renderFoldReceipt({ startSeq, endSeq, memberSeqs, forms = [], chars = 0, tokens = null }) {
  const members = Array.isArray(memberSeqs) ? memberSeqs : []
  const counts = new Map()
  for (const form of Array.isArray(forms) ? forms : []) {
    const label = form === 'receipt' ? '回执凭证' : form === 'working-set' || form === 'working-state' ? '工作状态卡' : '回注包'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([label, count]) => `${label} ${count} 张`).join('、')
  return [
    FOLD_RECEIPT_MARKER,
    // P0-5 / v1.2 P5-3：折叠也是一次投影，同样要同时声明率与失真。
    buildProjectionHeader({
      releasedTokens: Number.isFinite(Number(tokens)) ? Number(tokens) : 0,
      releasedChars: Math.max(0, Math.trunc(Number(chars) || 0)),
      readbackTokens: Number.isFinite(Number(tokens)) ? Number(tokens) : null,
    }),
    `折叠卡 ${members.length} 张（${parts || '插件工作卡'}）：seq ${startSeq}–${endSeq}。本条为程序折叠回执，成员原文在 append-only 日志，可按记录 ID 回读。`,
    // P0-4 不变量：回执必须保留**全部成员 ID**，否则「替换」变成了「删除」。
    // maxRun=8 保证这一行有界；成员 seq 是恢复与对账的唯一句柄。
    `成员：${members.map((seq) => 'seq:' + seq).join('、')}`,
  ].join('\n')
}
