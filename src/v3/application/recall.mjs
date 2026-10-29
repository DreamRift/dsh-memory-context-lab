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

/**
 * 结果面（display）隐含下限。
 *
 * 为什么它必须被导出：设置页只暴露一个「装包阈值」（`packMinScore`，下界 0，
 * 文案写着「0 表示不过滤」），而用例内部另有一个 `resultMinScore = 0.01` 的默认值。
 * 两者之间的约束是「装包面 ⊆ 结果面」，即 `packMinScore ≥ resultMinScore`。
 * 于是用户把装包阈拖到 0（文案承诺的合法取值）时，**每一步**的回注都会在
 * `applyMinScore` 抛 `V3ContractViolation`，被 `recallForInjection` 记成 failed——
 * 一个设置页允许、文档鼓励的值，让功能整体失效，而观察面只看到「失败 N 次」。
 *
 * 修法不是放宽校验（那会让「装包面只会更严」这条不变量失效），而是把
 * 「结果面下限」变成**可被调用方派生**的公开量：设置侧按
 * `Math.min(RECALL_RESULT_MIN_SCORE, packMinScore)` 给出成对参数，
 * 让用户说的「不过滤」真的落到两面都不过滤。
 */
export const RECALL_RESULT_MIN_SCORE = 0.01

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

/** OOV 词表在回注包里的展示上界（完整性由计数行承担，不靠无限枚举）。 */
export const RECALL_OOV_MAX_TERMS = 8

/**
 * 有界、去重的 OOV 词表。
 *
 * 旧实现直接 `join('、')`：查询是整条用户消息时，CJK 分词会给每个字生成「单字 + 双字」，
 * 一条 1200 字的新词长句能把词表撑到几千项，头部行单独就超过 4000 字符硬顶。
 * 展示有界、总数如实（`等 N 个`），是「省略可见」而不是「没发生」。
 */
export function boundedTerms(terms) {
  const unique = [...new Set(Array.isArray(terms) ? terms : [])]
  if (unique.length <= RECALL_OOV_MAX_TERMS) return unique
  return [...unique.slice(0, RECALL_OOV_MAX_TERMS), '等 ' + unique.length + ' 个']
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

  const api = async function recall({ query, turn, limit = 10, resultMinScore = 0.01, packMinScore = 0.5, previewChars = RECALL_PREVIEW_CHARS, allowRebuild = true, excludeRecordIds = null } = {}) {
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
    let result = await provider.search(query, { limit, resultMinScore, packMinScore, allowRebuild })
    const excluded = excludeRecordIds instanceof Set
      ? excludeRecordIds
      : new Set(Array.isArray(excludeRecordIds) ? excludeRecordIds.filter((id) => typeof id === 'string') : [])
    if (excluded.size > 0 && Array.isArray(result.pack)) {
      const pack = result.pack.filter((hit) => !excluded.has(hit.id))
      result = { ...result, pack, display: (result.display ?? []).filter((hit) => !excluded.has(hit.id)) }
    }
    if (result.pack.length === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      // 「无命中」不等于「没有可用信号」：全部词都 OOV 时，最需要披露的是那些词。
      // 旧实现把 oovTerms 塞进返回值却没有任何调用方读，观察面只显示「无命中」。
      const oov = boundedTerms(result.oovTerms)
      // 「索引还没追上」与「真的没命中」是两种事实，不得同形（见 t1-provider 的
      // allowRebuild 分支：热路径宁可回空也不重建）。把它如实披露，否则用户在
      // 新会话第一回合看到的「无命中」会与「检索坏了」无法区分。
      const reason = result.indexAbsent === true
        ? '索引尚未就绪（后台重建中，本步不回注）'
        : (result.display.length > 0
          ? '命中不足装包阈（纯壳不注入）'
          : (oov.length > 0 ? '无命中（词表外词：' + oov.join('、') + '）' : '无命中'))
      return {
        injected: false,
        reason,
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

    const headerLines = ['回注包（命中 ' + result.pack.length + ' 条；来源：' + (result.sourceLabel ?? '本地词法索引') + '）']
    if (result.oovTerms.length > 0) {
      headerLines.push('词表外词（未参与打分）：' + boundedTerms(result.oovTerms).join('、'))
    }
    const hitLines = []
    const hitPackIndex = [] // hitLines[n] 对应的 result.pack 下标（不可读命中被跳过，两者会错位）
    const sourceTexts = [] // 每条命中的原文（预算不足时据此缩短首部，见 compose）
    const hitTimes = [] // D-13 口径（2026-10-26 拍板「优先保最新的」）：截断丢最旧，不砍尾部
    let unreadableHits = 0
    for (let packIndex = 0; packIndex < result.pack.length; packIndex += 1) {
      const hit = result.pack[packIndex]
      let record = null
      try {
        record = await provider.read(hit.id)
      } catch (error) {
        // 单条读取失败不得废掉整包（旧实现让一条 ESTORE_CORRUPT 把同回合全部命中丢掉）。
        // 失败仍要留痕：计数 + 包内如实标注「N 条读取失败」，不静默跳过。
        unreadableHits += 1
        metrics?.counter?.('v3.recall.hit-unreadable', 1)
        continue
      }
      const recordText = record?.text ?? ''
      // 比较与切片必须用同一把尺子（码点）：`text.length` 是 UTF-16 码元，`sliceByChars` 是码点。
      // 混用会让含代理对（emoji）的短文本被判为「超长」，于是全文保留还加一个省略号。
      const preview = [...recordText].length > previewChars ? sliceByChars(recordText, previewChars) + '…' : recordText
      hitLines.push('· ' + hit.id + '（相关度 ' + hit.score.toFixed(3) + '）首部：' + preview)
      // 收缩路径必须按 hitLines 自己的映射取 pack 项：不可读命中被 continue 跳过后，
      // hitLines[n] 与 result.pack[n] 不再同指——旧实现用 result.pack[n] 打 ID，
      // 会把「可读正文」标成另一条（不可读）记录的 ID（审计 E-A 实测）。
      hitPackIndex.push(packIndex)
      // 原文单独留一份：预算收敛时要按可用余量**缩短首部**，不得只靠「整条丢弃」。
      sourceTexts.push(recordText)
      hitTimes.push(Number.isFinite(record?.record?.createdAt) ? record.record.createdAt : 0)
    }
    if (hitLines.length === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      return { injected: false, reason: '命中记录全部不可读（' + unreadableHits + ' 条）', display: result.display, oovTerms: result.oovTerms }
    }
    if (unreadableHits > 0) headerLines.push('读取失败：' + unreadableHits + ' 条命中不可读（已如实跳过，不代表没有）')
    // 注入上界（P0-4）：超出硬顶时保完整行截断，省略可见、可按 ID 回读——不静默缩每条。
    // 上界必须对**最终正文**成立：省略行与回读尾行都在预算内（H-05：旧实现先算长度再追加两行，
    // 结果超上限；省略条数还用 lines.length-2 硬编码「标题+OOV」两行，无 OOV 时多算一条）。
    // 句柄必须指向**真实存在**的入口：beta.10 这里印的是 `memory_lab_recall(...)`，
    // 而本版没有注册任何模型可见工具（工具集恒定），模型照抄只会拿到 unknown tool。
    const tailLine = '按 ID 精确回读全文：/memory-lab read ' + hitLines[0].split('（')[0].replace('· ', '') + '（同回合其余 ID 见上）；丢弃不等于不存在。'
    // 超预算时丢 createdAt 最旧的行（保显示分数序；丢弃集合按时间选出，省略行如实计数）。
    // 时间戳缺失（回落 0）时按**原始下标倒序**丢弃：下标 0 是分数最高的一条，
    // 旧实现按正序丢，等价于「先丢最相关的」。缺时间的记录无法判新旧，就不拿它开刀。
    const orderToDrop = hitTimes
      .map((at, n) => ({ at, n }))
      .sort((a, b) => (a.at - b.at) || (b.n - a.n))
      .map((x) => x.n)
    /** 按每条命中的原文重建一行（首部长度可变）。 */
    const hitLineAt = (n, capChars) => {
      const text = sourceTexts[n] ?? ''
      const preview = [...text].length > capChars ? sliceByChars(text, capChars) + '…' : text
      const packHit = result.pack[hitPackIndex[n] ?? n]
      return '· ' + packHit.id + '（相关度 ' + packHit.score.toFixed(3) + '）首部：' + preview
    }
    /**
     * 组装回注包。
     * @param keepCount 保留的命中条数（其余按 orderToDrop 丢弃并如实计数）
     * @param capChars 每条首部保留多少个**码点**
     */
    const compose = (keepCount, capChars) => {
      const dropped = new Set(orderToDrop.slice(0, hitLines.length - keepCount))
      const omitted = hitLines.length - keepCount
      const lines = [...headerLines]
      for (let n = 0; n < hitLines.length; n += 1) {
        if (dropped.has(n)) continue
        lines.push(capChars >= previewChars ? hitLines[n] : hitLineAt(n, capChars))
      }
      if (omitted > 0) lines.push('注入上界：超出 ' + RECALL_PACK_MAX_CHARS + ' 字符的 ' + omitted + ' 条已省略（按 ID 回读全文）')
      lines.push(tailLine)
      return lines
    }
    const lengthOf = (lines) => lines.join('\n').length

    // ① 先按用户设置的 previewChars 丢命中：这是 `previewChars` 的**本义**
    //    （「每条保留多少首部字符」），丢掉的条数如实计入省略行。
    let cap = previewChars
    let keep = hitLines.length
    let lines = compose(keep, cap)
    while (lengthOf(lines) > RECALL_PACK_MAX_CHARS && keep > 0) {
      keep -= 1
      lines = compose(keep, cap)
    }
    // ② 只有「连一条命中都放不下」时，才把首部压短作为兜底。
    //
    // 为什么需要这一步：`previewChars` 在设置页的上界就是硬顶（4000），而一条命中行
    // 除了首部还有「· <id>（相关度 x.xxx）首部：」的前缀。用户把首部长度拖到上限时，
    // **单条命中行单独就超预算**——旧实现只会整条丢弃，于是 keep 一路收敛到 0，
    // 整包退化成只有标题与尾行的「纯壳」被拒绝注入：一个设置页允许、Schema 校验
    // 通过的合法值让回注 100% 失效，观察面只显示「预算被固定行占满」。
    //
    // 口径：首部长度是**上限**不是下限，装不下时按余量压短是收紧而不是放宽——
    // 总字符数仍 ≤ 硬顶，且被压短的行以「…」明示截断。
    if (keep === 0) {
      let shrunk = previewChars
      while (shrunk > 0) {
        const over = lengthOf(lines) - RECALL_PACK_MAX_CHARS
        shrunk = Math.max(0, shrunk - Math.max(1, Math.ceil(over / Math.max(1, hitLines.length))))
        const retry = compose(hitLines.length, shrunk)
        if (lengthOf(retry) <= RECALL_PACK_MAX_CHARS) {
          metrics?.counter?.('v3.recall.preview-shrunk', 1)
          cap = shrunk
          keep = hitLines.length
          lines = retry
          break
        }
      }
    }
    const pack = lines.join('\n')
    // 头尾固定行本身超上限（超长 OOV 词表）：**拒绝注入**而不是带着「已超限」的包进模型。
    // 硬顶是「能注入→有上界」的承诺，capExceeded 只做标记等于失败开放。
    if (pack.length > RECALL_PACK_MAX_CHARS) {
      metrics?.counter?.('v3.recall.cap-exceeded', 1)
      return {
        injected: false,
        reason: '回注包固定行超过硬顶 ' + RECALL_PACK_MAX_CHARS + ' 字符（拒绝注入）',
        display: result.display,
        oovTerms: result.oovTerms,
        capExceeded: true,
      }
    }
    // 零命中的「纯壳」不注入：预算被固定行占满时 keep 会收敛到 0，
    // 若只判长度就会把一条命中都没有的壳包塞进模型（与「纯壳不注入」纪律相悖）。
    if (keep === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      return { injected: false, reason: '预算被固定行占满，命中条目全部放不下（纯壳不注入）', display: result.display, oovTerms: result.oovTerms }
    }
    if (keep < hitLines.length) metrics?.counter?.('v3.recall.pack-truncated', 1)
    metrics?.counter?.('v3.recall.injected', 1)
    return {
      injected: true,
      text: pack,
      hits: result.pack,
      injectedHits: keep,
      omittedHits: hitLines.length - keep,
      unreadableHits,
      capExceeded: false,
      oovTerms: result.oovTerms,
    }
  }
  api.readByRef = readByRef
  return api
}
