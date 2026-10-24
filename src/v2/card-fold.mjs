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
 * 卡片净占用上限（字符）。0.12.0 P0-4；0.13.2-beta.8 重校准。
 *
 * beta.7 实测 512 张卡 / 306,071 字符对 4000 上限 76.5 倍超标——折叠的「连续卡组」
 * 前提在真实序列里永不成立，4000 只是纯告警。beta.8（Q3-A）治理改成「一进一出」：
 * 注入即替换，稳态面上恒为 [全量基准卡][最新增量卡] 两个卡节点，净占用上界由双槽
 * 不变量构造性保证（全量 ≤ cardTokens 预算口径 ≈ ≤4.8k 字符 + 增量 ≤1600 字符 +
 * 两行占位回执）。本上限随之**降级为兜底告警线**：触发即说明双槽不变量被破坏
 * （如 replace 持续失败降级 append），阈值取双槽理论最坏 ≈6.6k 的上取整并留余量。
 */
export const CARD_NET_CHAR_CAP = 8000

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
  let newestFullCardSeq = null
  for (const node of ordered) {
    if (!isCardNode(node)) continue
    chars += typeof node.text === 'string' ? node.text.length : 0
    count += 1
    if (node.sourceForm === 'working-set' || node.sourceForm === 'working-state') {
      newestWorkingStateSeq = node.seq
      // 0.13.0 F5：增量卡的语义是「相对上一张**全量卡**的变化」，所以全量卡
      // 本身就是增量卡的基准。实测里最新一张全量卡（seq 2565）被折掉后，
      // 后续增量卡仍写「未列出的行以最近一张全量卡为准」——模型看不到基准。
      // 因此最新全量卡与最新工作卡一样，必须永不被折。
      if (isFullCardText(node.text)) newestFullCardSeq = node.seq
    }
  }
  return { chars, count, newestWorkingStateSeq, newestFullCardSeq, overCap: chars > CARD_NET_CHAR_CAP }
}

/**
 * 一张工作卡是不是**全量卡**（而不是增量卡）。
 *
 * 判据是渲染头：全量卡以「[工作状态·v2]（」开头，增量卡以「[工作状态·v2·增量]」
 * 开头。只做前缀判定，不解析正文——卡片正文属于渲染层，折叠层不依赖它的结构。
 */
export function isFullCardText(text) {
  if (typeof text !== 'string') return false
  return text.startsWith('[工作状态·v2]') && !text.startsWith('[工作状态·v2·增量]')
}

/**
 * 一个节点是不是插件工作卡。**只认 sourceForm ∈ CARD_FOLD_FORMS**。
 *
 * 0.13.0 F0（恢复率 0.9% 的根因）：归档回执曾经也算卡（正文以
 * `[已归档操作·v2]` 开头即命中）。折叠把整组回执换成一条只留 `seq:` 的
 * 折叠回执，于是 `restoreReceipts` 按 `replacementSeq` 找不到回执节点，
 * 逐条判 `回执节点已不在活动面` 并 skip——**回执是 restore 的唯一句柄**，
 * 折掉它等于把「原文可恢复」这条承诺删掉。实测 230 条归档里 221 条因此
 * 不可恢复。
 *
 * 所以归档回执与回注包一样是**断组边界**：折叠只治理插件自己的工作状态卡。
 * 回执的生命周期交给归档管线（净占用闸门）与 restore，不由折叠管理。
 *
 * 注意：`V2_RECEIPT_MARKER` 仍要识别——它是 `isReceiptMessage` 与凭证判定
 * 的依据，只是不再让节点成为**可折叠**的卡。
 */
export function isCardNode(node) {
  if (!node || node.type !== 'user/message') return false
  return typeof node.sourceForm === 'string' && CARD_FOLD_FORMS.includes(node.sourceForm)
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
/** 形态 → 折叠回执里的中文标签（0.13.0 F3：单一真源，未知形态不猜）。 */
const FORM_LABELS = Object.freeze({
  'working-set': '工作状态卡',
  'working-state': '工作状态卡',
  'archive-receipt': '归档回执',
  'memory-lab2-surface': '折叠回执',
  recall: '回注包',
})

export function renderFoldReceipt({ startSeq, endSeq, memberSeqs, forms = [], chars = 0, tokens = null }) {
  const members = Array.isArray(memberSeqs) ? memberSeqs : []
  // 0.13.0 F4：区间端点必须有序。成员按**活动面顺序**排列，而 replace 事件拿到的
  // seq 可能比左侧更早的节点小，于是出现过「seq 243–189」「802–770」这种倒置区间
  // （实测 4 处）。模型看到 243–189 会读成一个不可能的跨度，恢复对账也会混淆。
  const ordered = members.filter((seq) => Number.isInteger(seq)).sort((a, b) => a - b)
  const lo = ordered.length > 0 ? ordered[0] : startSeq
  const hi = ordered.length > 0 ? ordered[ordered.length - 1] : endSeq
  const counts = new Map()
  for (const form of Array.isArray(forms) ? forms : []) {
    // 0.13.0 F3：归档回执曾被一律标成「回注包」——两者是完全不同的东西
    // （回执是 restore 句柄，回注包是当轮检索证据）。标签表按形态显式列出，
    // 未知形态如实写「未知形态」而不是猜一个。
    const label = FORM_LABELS[form] ?? '未知形态'
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
    `折叠卡 ${members.length} 张（${parts || '插件工作卡'}）：seq ${lo}–${hi}。本条为程序折叠回执，成员原文在 append-only 日志，可按记录 ID 回读。`,
    // P0-4 不变量：回执必须保留**全部成员 ID**，否则「替换」变成了「删除」。
    // maxRun=8 保证这一行有界；成员 seq 是恢复与对账的唯一句柄。
    `成员：${members.map((seq) => 'seq:' + seq).join('、')}`,
  ].join('\n')
}
