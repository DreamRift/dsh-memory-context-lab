/**
 * recall 用例（application，M4 第二批）。
 *
 * 判据（0.12.0 保留族）：
 * - 纯壳不注入：无合格命中（低于装包阈）不注入空块（recall-gate）；
 * - 回注包带确定性首部切片（N-03：切片是定长首部，不是摘要不是全文）；
 * - OOV 词单独披露（retrieval-contract F3）；
 * - 同回合同类回注只一次（P3：domain 的 oncePerTurnGate，category=recall-injection）；
 * - 句柄可执行：正文里给 memory 侧可照抄的按 ID 回读形态（readback-affordance）。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { assertPort } from '../ports/index.mjs'
import { oncePerTurnGate } from '../domain/session/turn.mjs'

/** 确定性首部切片长度（N-03 口径）。 */
export const RECALL_PREVIEW_CHARS = 160

/** 注入上界（P0-4：能注入→有上界；2026-10-25 用户拍板移植⑤）：回注包总字符硬顶。 */
export const RECALL_PACK_MAX_CHARS = 4000

/** 精确记录 ID 形态（v3r- + 16 位十六进制）；不匹配即按别名走解析（⑨）。 */
export function isExactRecordId(ref) {
  return typeof ref === 'string' && /^v3r-[0-9a-f]{16}$/.test(ref)
}

/** 按码点切片（UTF-16 slice 会把代理对切成半个——reliability 码点纪律的 v3 落点）。 */
export function sliceByChars(text, n) {
  return [...text].slice(0, n).join('')
}

export function createRecall({ provider, metrics, sessionKey } = {}) {
  assertPort('MemoryProvider', provider)
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 recall: sessionKey 必须是非空字符串')
  }
  let seen = new Set()

  /** 按 ID 或别名回读（⑨ 别名解析，2026-10-25 用户拍板移植）：别名经端口可选方法解析，未实现则失败关闭。 */
  async function readByRef(ref) {
    if (isExactRecordId(ref)) return provider.read(ref)
    if (typeof provider.resolveAlias !== 'function') {
      throw new V3ContractViolation('v3 recall: 引用不是精确记录 ID 且提供者未实现 resolveAlias（别名解析不可用）')
    }
    const resolved = await provider.resolveAlias(ref)
    if (resolved === null || resolved === undefined) {
      throw new V3ContractViolation('v3 recall: 别名未命中：' + ref)
    }
    return provider.read(resolved)
  }

  const api = async function recall({ query, turn, limit = 10, resultMinScore = 0.01, packMinScore = 0.5, previewChars = RECALL_PREVIEW_CHARS } = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new V3ContractViolation('v3 recall: 查询必须是非空白字符串（空查询失败关闭）')
    }
    if (!Number.isInteger(turn) || turn < 1) {
      throw new V3ContractViolation('v3 recall: turn 必须 ≥1（turn 0 不允许注入）')
    }
    // H-47：切片长度必须落在 [0, +∞) 的整数域。旧实现直接拿调用方的值做
    // `text.length > previewChars` 与 `slice(0, previewChars)`：
    // - 负数 → slice(0,-1) 取「除最后一个字符外的全文」（越界**放宽**）；
    // - NaN / Infinity / 非数字 → 比较恒为 false → 直接注入**全文**。
    // 两者都绕过 N-03 的「定长首部切片」纪律：回注包不是摘要也不是全文，
    // 而这两条路径把 800 字符正文原样塞进下一步的上下文。
    if (!Number.isInteger(previewChars) || previewChars < 0) {
      throw new V3ContractViolation('v3 recall: previewChars 必须是 ≥0 的整数（得到 ' + JSON.stringify(previewChars) + '）——负数会 slice(0,-1) 取到全文，NaN/Infinity 会让比较恒假')
    }
    // 切片长度超过整包硬顶没有意义（一条命中就撑满整个回注包，其余全被省略）：
    // 这种参数不是「多要一点」，是配置错误。失败关闭而不是静默当成「全要」。
    if (previewChars > RECALL_PACK_MAX_CHARS) {
      throw new V3ContractViolation('v3 recall: previewChars 不得超过回注包硬顶 ' + RECALL_PACK_MAX_CHARS + '（得到 ' + previewChars + '）')
    }
    const result = await provider.search(query, { limit, resultMinScore, packMinScore })
    if (result.pack.length === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      return {
        injected: false,
        reason: result.display.length > 0 ? '命中不足装包阈（纯壳不注入）' : '无命中',
        display: result.display,
        oovTerms: result.oovTerms,
      }
    }
    const gate = oncePerTurnGate(seen, sessionKey, turn, 'recall-injection')
    if (!gate.emit) {
      metrics?.counter?.('v3.recall.gated', 1)
      return { injected: false, reason: '本回合已注入过同类回注（P3 命中只出现一步）', display: result.display, oovTerms: result.oovTerms }
    }
    seen = gate.seen

    const headerLines = ['回注包（命中 ' + result.pack.length + ' 条；来源：本地词法索引）']
    if (result.oovTerms.length > 0) {
      headerLines.push('词表外词（未参与打分）：' + result.oovTerms.join('、'))
    }
    const hitLines = []
    const hitTimes = [] // D-13 口径（2026-10-26 拍板「优先保最新的」）：截断丢最旧，不砍尾部
    for (const hit of result.pack) {
      const record = await provider.read(hit.id)
      const text = record?.text ?? ''
      const preview = text.length > previewChars ? sliceByChars(text, previewChars) + '…' : text
      hitLines.push('· ' + hit.id + '（相关度 ' + hit.score.toFixed(3) + '）首部：' + preview)
      hitTimes.push(Number.isFinite(record?.record?.createdAt) ? record.record.createdAt : 0)
    }
    // 注入上界（P0-4）：超出硬顶时保完整行截断，省略可见、可按 ID 回读——不静默缩每条。
    // 上界必须对**最终正文**成立：省略行与回读尾行都在预算内（H-05：旧实现先算长度再追加两行，
    // 结果超上限；省略条数还用 lines.length-2 硬编码「标题+OOV」两行，无 OOV 时多算一条）。
    const tailLine = '按 ID 精确回读全文：memory_lab_recall(record_ids=["' + result.pack[0].id + '", …])；丢弃不等于不存在。'
    // 超预算时丢 createdAt 最旧的行（保显示分数序；丢弃集合按时间选出，省略行如实计数）
    const orderToDrop = hitTimes
      .map((at, n) => ({ at, n }))
      .sort((a, b) => (a.at - b.at) || (a.n - b.n))
      .map((x) => x.n)
    const compose = (keepCount) => {
      const dropped = new Set(orderToDrop.slice(0, hitLines.length - keepCount))
      const omitted = hitLines.length - keepCount
      const lines = [...headerLines, ...hitLines.filter((_, n) => !dropped.has(n))]
      if (omitted > 0) lines.push('注入上界：超出 ' + RECALL_PACK_MAX_CHARS + ' 字符的 ' + omitted + ' 条已省略（按 ID 回读全文）')
      lines.push(tailLine)
      return lines
    }
    let keep = hitLines.length
    let lines = compose(keep)
    while (lines.join('\n').length > RECALL_PACK_MAX_CHARS && keep > 0) {
      keep -= 1
      lines = compose(keep)
    }
    const pack = lines.join('\n')
    // 头尾固定行本身超上限（previewChars 荒谬大 / OOV 词表极长）：如实标记，不静默当作已满足
    const capExceeded = pack.length > RECALL_PACK_MAX_CHARS
    if (keep < hitLines.length) metrics?.counter?.('v3.recall.pack-truncated', 1)
    metrics?.counter?.('v3.recall.injected', 1)
    return {
      injected: true,
      text: pack,
      hits: result.pack,
      injectedHits: keep,
      omittedHits: hitLines.length - keep,
      capExceeded,
      oovTerms: result.oovTerms,
    }
  }
  api.readByRef = readByRef
  return api
}
