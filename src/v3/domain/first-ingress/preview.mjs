/**
 * P7「超大工具结果首次呈现」纯函数（0.15.0 候选，**默认关闭**）。
 *
 * ## 为什么是纯函数
 * 预览文本、句柄、两种 hash 与幂等 ID 必须确定性：同一来源事件 + 同一原文 hash + 同一策略版本
 * 渲染出的字节必须逐字相同（开发流程 §3.4）。日期、占用率、随机数一律不进正文。
 *
 * ## 首次入模的源码依据（不据此宣称真机已验证）
 * - dsh-agent-loop：preStep 在每次请求前 await（lib/index.js:902-927、turn 循环 :956），
 *   buildRequest 到 :1274 才 deriveMessages()——pre-step 内改写活动面即进入本步请求；
 * - dsh-session：tool/result 替换只允许「恰好 1 个当前 tool/result、仅改 message.content」
 *   （lib/index.js:394-412）；
 * - dsh-compaction-tool-result-pruner：生产代码就是 append("tool/result", {...data, message},
 *   {surfaceOp: replace, sourceEventSeqs:[seq]})（lib/index.js:167-177）。
 * 真机时序、其他 hooked 插件次序、非 agent-loop 请求（摘要/标题）是否携带原文**未验**（G8）。
 *
 * ## 受限边界
 * 只处理**纯文本**工具结果（§3.6「限于确定可完整持久化的纯文本」）；图文混排、媒体、
 * 已带本标记的正文一律不动。hash 是变更检测（FNV-1a 64 位），不承担防篡改。
 *
 * ## 回执要素（G4 §10）
 * 回执必须给模型：用途摘要、稳定来源 ID（来源事件 + 记录 ID + 幂等 ID）、明确未展示范围
 * （码点区间与省略字数）、**能实际分页的 memory_context_read 入口**（id/offset/length/cursor）；
 * 两种哈希分别命名（宿主原文 surface-content-hash / 已落库副本 record-text-hash）。
 * 命令面 /memory-lab read 是 UTF-16、单次上限、不分页的另一条通道：回执里如实提示不要依赖它。
 *
 * ## 外置阈值与回读上限同源
 * 阈值从 contracts/readback.mjs 派生（上限的 75%），本文件不写绝对上限；判定与读侧同尺
 * （工具面码点语义见 contracts/readback.mjs 的 READBACK_OFFSET_UNIT 裁决）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { isRecordId } from '../../contracts/records.mjs'
import {
  FIRST_INGRESS_HASH_KINDS,
  FIRST_INGRESS_ID_PREFIX,
  FIRST_INGRESS_POLICY_VERSION,
  FIRST_INGRESS_READ_PAGE_CHARS,
  FIRST_INGRESS_THRESHOLD_CHARS,
  READBACK_MAX_CHARS,
  READBACK_OFFSET_UNIT,
} from '../../contracts/readback.mjs'
import { MEMORY_CONTEXT_TOOL_NAMES, OWN_TOOL_RESULT_MARKER } from '../../contracts/tools.mjs'
import { PLUGIN_SOURCE_KIND, RECALL_SOURCE_FORM, RECEIPT_SOURCE_FORM, RESTORE_SOURCE_FORM } from '../../contracts/sources.mjs'

/** 预览正文的稳定标记：既是「已经外置」的幂等判据，也是「read 回来的内容不再外置」的护栏。 */
export const FIRST_INGRESS_TOKEN = '[mcl-first-ingress]'

/**
 * 回读来源形态（P2-3）：插件自己写回活动面的恢复/回注/回执正文不是「新工具结果」。
 * 只认来源标记，不按正文猜——正文里出现记录原文也可能是用户真的贴了一份。
 */
const READBACK_SOURCE_FORMS = new Set([RECALL_SOURCE_FORM, RECEIPT_SOURCE_FORM, RESTORE_SOURCE_FORM])

/**
 * 默认预算（字符=Unicode 码点；判定尺见 shouldExternalize）。
 *
 * 首轮标定值，不是已测参数。thresholdChars 必须来自 READBACK_MAX_CHARS 的派生，
 * 不得在本文件写死回读上限——两处各写数字正是 P1-1 的成因。
 */
export const FIRST_INGRESS_DEFAULTS = Object.freeze({
  thresholdChars: FIRST_INGRESS_THRESHOLD_CHARS,
  headChars: 600,
  tailChars: 200,
})

/** 行列无关的规范 JSON（键排序、递归稳定）——hash 的唯一序列化口径。 */
export function canonicalJson(value) {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  return JSON.stringify(value)
}

/** FNV-1a 64 位（变更检测，非密码学）。与 contracts/cache-observation 同族但独立口径（对象 vs 文本）。 */
function fnv1a64(text) {
  const bytes = new TextEncoder().encode(text)
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & mask
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/** 工具结果 content 的**宿主原文** hash（调用方写入前取自原文，写入时由端口复核）。 */
export function contentHashOf(blocks) {
  return fnv1a64(canonicalJson(blocks))
}

/** 只取 text 块的正文（非 text 块不参与文本预算）。 */
// T3：与 entry 共用唯一实现（`domain/text/blocks.mjs`）；预览面按「连续拼接」。
export { textOfBlocks } from '../text/blocks.mjs'
import { textOfBlocks } from '../text/blocks.mjs'

/** 码点长度（工具面偏移单位；也是展示口径的「共 N 字」）。 */
export function charCountOf(text) {
  return typeof text === 'string' ? Array.from(text).length : 0
}

/**
 * 本机制**自己生成的**预览正文的头部形态（唯一真源）。
 *
 * 判据是「**首行以 token 开头**」——位置比句式更重要：本机制生成的回执必然以 token 打头，
 * 而「正文里提到标记」不会。这样才排得掉一种真实场景：
 * 用户/V3 的工具输出正文里本来就**提到** `[mcl-first-ingress]`（例如贴了一段插件日志、
 * 或引用本插件的说明），旧实现用整篇 `includes` 判定，于是把它误认成「已外置」而**永久跳过**
 * 外置，状态面还会报「externalized」（P2-11）。
 */
export const FIRST_INGRESS_PREVIEW_HEAD_RE = /^\[mcl-first-ingress\](?: |$)/

/** 是否已是**本机制自己生成**的预览正文（幂等 + 防「取回→再藏」死循环）。 */
export function isPreviewContent(blocks) {
  const text = textOfBlocks(blocks)
  // 只认首行头部形态：正文中途提到标记不是「已外置」，否则真实数据会被永久跳过。
  return FIRST_INGRESS_PREVIEW_HEAD_RE.test(text)
}

/**
 * 纯文本且超阈值才值得外置；非 text 块一律不碰。
 *
 * 判定尺 = text.length（UTF-16 单元），与命令面 /memory-lab read 的截断判定同一把尺：
 * 换成码点会让一批「码点少、UTF-16 长」的正文（emoji/增补平面）在阈值下被外置，而命令面回读
 * 却仍截断。工具面（memory_context_read）本身按码点分页，两者不冲突（C-G1-09）。
 */
export function shouldExternalize(blocks, config = {}) {
  const threshold = Number.isFinite(config.thresholdChars) ? config.thresholdChars : FIRST_INGRESS_DEFAULTS.thresholdChars
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  if (blocks.some((block) => block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string')) return false
  if (isPreviewContent(blocks)) return false
  return textOfBlocks(blocks).length > threshold
}

/**
 * 这条 tool/result 是否来自「回读」而不是一次新工具执行（P2-3 / G4「读回工具再次进入入口」）。
 *
 * 判据只看来源标记（任一命中即算）：
 * - source.readbackOf 是合法记录 ID（显式回读标记）；
 * - source.kind = 插件自有 kind（插件写回活动面的正文）；
 * - source.form 属于恢复/回注/回执形态；
 * - 正文首部（去前导空白后）以本插件工具结果标记开头——即 memory_context_read/search/compact
 *   自己的输出又被当作文本结果落面（工具面回读；与 entry 的 hasOwnToolMarker 同一条判据，
 *   标记常量来自 contracts/tools.mjs，不在这里另写一份）。
 *
 * 已知边界（不夸大）：没有来源标记的第三方回读识别不了——本机制只能挡住
 * 自己标了来源的那条路；未标记的回读按普通工具结果处理，写入文档而不是猜。
 */
export function isReadbackResult(event) {
  const sources = [event?.data?.message?.source, event?.data?.source, event?.source]
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    if (typeof source.readbackOf === 'string' && isRecordId(source.readbackOf)) return true
    if (typeof source.kind === 'string' && source.kind === PLUGIN_SOURCE_KIND) return true
    if (typeof source.form === 'string' && READBACK_SOURCE_FORMS.has(source.form)) return true
  }
  const head = textOfBlocks(event?.data?.message?.content).trimStart()
  if (head.startsWith(OWN_TOOL_RESULT_MARKER)) return true
  return false
}

/**
 * 按 callId 找回工具身份（工具名/callId）。
 *
 * 宿主把调用声明放在 assistant/message 的 tool-call 块里（dsh-agent-loop），
 * 结果事件本身只有 toolCallId/source.callId。找不到就返回 null——预览如实写「未知」，
 * 不拿「tool」之类占位名冒充身份。
 */
export function toolCallOf({ nodes, eventAt, callId } = {}) {
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') {
    throw new V3ContractViolation('v3 first-ingress: toolCallOf 需要 nodes 与 eventAt')
  }
  if (typeof callId !== 'string' || callId.length === 0) return null
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      const id = typeof block.callId === 'string' && block.callId.length > 0
        ? block.callId
        : (typeof block.id === 'string' && block.id.length > 0 ? block.id : null)
      if (id !== null && id === callId) {
        return { name: typeof block.name === 'string' && block.name.length > 0 ? block.name : null, callId: id }
      }
    }
  }
  return null
}

/**
 * 外置事实的确定性身份（幂等 ID）：同一「会话 + 来源事件 + 原文 hash + 策略版本」恒等。
 *
 * 重试/重启后按它判断「这条是不是已经外置过」，避免反复替换或重复外置（G4 §10）。
 * 不是密码学摘要，不能当安全边界（contracts/readback.mjs 的边界说明同口径）。
 */
export function externalIdOf({ sessionKey, sourceEventId, surfaceContentHash, policyVersion } = {}) {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 first-ingress: 幂等 ID 需要会话键（跨会话不得复用同一身份）')
  }
  if (typeof sourceEventId !== 'string' || sourceEventId.length === 0) {
    throw new V3ContractViolation('v3 first-ingress: 幂等 ID 需要来源事件 ID（稳定来源身份）')
  }
  if (typeof surfaceContentHash !== 'string' || !/^[0-9a-f]{16}$/.test(surfaceContentHash)) {
    throw new V3ContractViolation('v3 first-ingress: 幂等 ID 需要 16 位小写十六进制的原文 hash')
  }
  const version = Number.isInteger(policyVersion) ? policyVersion : FIRST_INGRESS_POLICY_VERSION
  return FIRST_INGRESS_ID_PREFIX + fnv1a64(canonicalJson({
    session: sessionKey,
    source: sourceEventId,
    surface: surfaceContentHash,
    policy: version,
  }))
}

/**
 * 工具面分页计划（码点）：回执要如实写「共几页、每页多少、续读从哪开始」。
 *
 * pageChars 缺省 = contracts/readback.mjs 的 FIRST_INGRESS_READ_PAGE_CHARS，
 * 与 memory_context_read 的单页上界同源（不在这里另写一个数字）。
 */
export function pagingOf(text, pageChars = FIRST_INGRESS_READ_PAGE_CHARS) {
  const total = charCountOf(text)
  const perPage = Number.isInteger(pageChars) && pageChars > 0 ? pageChars : FIRST_INGRESS_READ_PAGE_CHARS
  const pages = total === 0 ? 0 : Math.ceil(total / perPage)
  const lastPageChars = total === 0 ? 0 : total - (pages - 1) * perPage
  return { total, pageChars: perPage, pages, lastPageChars }
}

/**
 * 回读入口行（G4）：只指向**能实际分页**的工具面。
 *
 * 三条线一起给：① 可直接执行的调用形态（id/offset/length）；② 分页语义（码点、单页上界、
 * 共几页、续读用 next_cursor 或 offset）；③ 命令面例外（UTF-16、单次上限、不分页，不要依赖）。
 */
export function readEntryLinesOf({ recordId, sourceEventId, externalId, text, surfaceContentHash, recordTextHash }) {
  if (!isRecordId(recordId)) {
    throw new V3ContractViolation('v3 first-ingress: 回读入口必须是既有记录 ID（v3r-<16 位小写十六进制>）')
  }
  const paging = pagingOf(text)
  const tool = MEMORY_CONTEXT_TOOL_NAMES.read
  const call = '{"id":' + JSON.stringify(recordId) + ',"offset":0,"length":' + paging.pageChars + '}'
  const lines = [
    '回读入口（可实际分页）：' + tool + ' ' + call,
    '分页：偏移单位 ' + READBACK_OFFSET_UNIT + '；单页最多 ' + paging.pageChars + ' 码点；共 ' + paging.pages
      + ' 页（末页 ' + paging.lastPageChars + ' 码点）；续读把返回的 next_cursor 放回 cursor，或用 offset='
      + String(paging.pages > 1 ? paging.pageChars : paging.total) + ' 从下一段读。',
    '命令面 /memory-lab read 是另一条通道（UTF-16 计数、单次 ' + READBACK_MAX_CHARS + ' 字截断、不分页），首次呈现后的回读不要依赖它。',
  ]
  if (typeof sourceEventId === 'string' && sourceEventId.length > 0) {
    lines.splice(0, 0, '来源身份：来源事件 ' + sourceEventId + '；记录 ' + recordId
      + (typeof externalId === 'string' && externalId.length > 0 ? '；幂等 ID ' + externalId : '')
      + '（同一来源 + 同一原文 hash + 同一策略版本只外置一次）。')
  }
  if (typeof surfaceContentHash === 'string' && typeof recordTextHash === 'string') {
    lines.splice(1, 0, '两种哈希：' + FIRST_INGRESS_HASH_KINDS.surface + '=' + surfaceContentHash
      + '（宿主原文 content hash，变更检测）；' + FIRST_INGRESS_HASH_KINDS.record + '=' + recordTextHash
      + '（已落库副本正文 hash，可能已脱敏/已改写）；两者不同义，不得互换。')
  }
  return lines
}

/**
 * 活动面工具配对（纯函数，不自带 session 依赖）。
 *
 * P7 的安全前提：**只有请求能合法派生时才允许改写**。若活动面还有未闭合的
 * tool-call（assistant 声明了调用、结果还没落面），此刻把某个 tool/result 换成预览，
 * 会让「本来就非法」的请求多一个可疑改写点，也可能把插件写进别人的半成品步骤。
 * 因此未闭合时整个用例不动作（不是少替换一个，是整轮跳过）。
 *
 * @param {object} deps { nodes: number[], eventAt(seq) => event }
 * @returns {{balanced: boolean, open: number, orphanResultSeq: number|null}}
 */
export function pairingOfSurface({ nodes, eventAt } = {}) {
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') {
    throw new V3ContractViolation('v3 first-ingress: pairingOfSurface 需要 nodes 与 eventAt')
  }
  let open = 0
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (Array.isArray(content)) open += content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      if (open <= 0) return { balanced: false, open: 0, orphanResultSeq: seq }
      open -= 1
    }
  }
  return { balanced: open === 0, open, orphanResultSeq: null }
}

/**
 * 表层状态判定（重试/重启后按幂等 ID 对账的唯一判据，G4 §10）。
 *
 * - externalized：正文就是本机制的预览，且带着**本次**幂等 ID（已外置，不重复做）；
 * - externalized-other：是预览，但幂等 ID 不是本次的（换了策略版本/别的写入者），不认领；
 * - original：content hash 与原文一致（可以安全外置）；
 * - unknown：既不是预览、又没有原文 hash 可比（不猜）；
 * - diverged：既不是预览也不是原文（已被别处改写，绝不覆盖）。
 */
export function surfaceStateOf({ content, externalId, expectedSurfaceHash } = {}) {
  if (!Array.isArray(content)) return 'diverged'
  const text = textOfBlocks(content)
  if (isPreviewContent(content)) {
    // 幂等 ID 必须出现在**回执区**（头部到正文区之间），不能靠整篇 includes 撞运气：
    // 正文里碰巧含同一串 hex 的概率虽低，但那会让「别人的预览」被认成本次的（P2-11 同源）。
    // 回执区 = 首行头部到「正文区」之前。真实预览里正文区前必有空行；手工拼接/旧版
    // 回执可能没有空行，此时退化为整篇（与原行为一致），不因为找不到分隔就把真回执判成别人的。
    const bodyStart = text.indexOf('\n\n')
    const receipt = bodyStart > 0 ? text.slice(0, bodyStart) : text
    return (typeof externalId === 'string' && externalId.length > 0 && receipt.includes(externalId))
      ? 'externalized'
      : 'externalized-other'
  }
  if (typeof expectedSurfaceHash !== 'string' || !/^[0-9a-f]{16}$/.test(expectedSurfaceHash)) return 'unknown'
  return contentHashOf(content) === expectedSurfaceHash ? 'original' : 'diverged'
}

/**
 * 生成确定性预览 content（G4 回执）。
 *
 * 保留：工具身份（工具名 + callId，找不到就如实写未知）、错误态、体量、**明确未展示范围**、
 * 稳定来源 ID、幂等 ID、两种哈希、可实际分页的回读入口、副本口径。
 * 同一输入 → 同一字节（测试锁死）。
 *
 * @param {object} deps
 * @param {Array<{type:'text',text:string}>} deps.content 记录正文（可能已脱敏）
 * @param {string} deps.handle 记录 ID
 * @param {string} deps.sourceEventId 稳定来源事件 ID（dsh-<seq>）
 * @param {string} deps.externalId 幂等 ID（fi-<16 hex>）
 * @param {string} deps.surfaceContentHash 宿主原文 hash（16 位小写十六进制）
 * @param {string} [deps.recordTextHash] 已落库副本正文 hash
 * @param {string|null} [deps.toolName] 工具名（宿主声明里取得）
 * @param {string|null} [deps.callId] 调用标识
 * @param {boolean} [deps.isError] 宿主 message.isError
 * @param {boolean|null} [deps.exactCopy] 记录正文是否与宿主原文按 content hash 一致
 */
export function previewBlocksOf(options = {}) {
  const { content, handle, sourceEventId, externalId, surfaceContentHash, recordTextHash = null, toolName = null, callId = null, isError = false, exactCopy = null, config = {} } = options
  const merged = { ...FIRST_INGRESS_DEFAULTS, ...config }
  const text = textOfBlocks(content)
  const total = charCountOf(text)
  if (total === 0) throw new V3ContractViolation('v3 first-ingress: 空正文没有可外置的内容')
  if (typeof sourceEventId !== 'string' || sourceEventId.length === 0) {
    throw new V3ContractViolation('v3 first-ingress: 回执必须带稳定来源 ID（来源事件 ID）')
  }
  if (typeof externalId !== 'string' || !/^fi-[0-9a-f]{16}$/.test(externalId)) {
    throw new V3ContractViolation('v3 first-ingress: 回执必须带幂等 ID（fi-<16 位小写十六进制））')
  }
  if (typeof surfaceContentHash !== 'string' || !/^[0-9a-f]{16}$/.test(surfaceContentHash)) {
    throw new V3ContractViolation('v3 first-ingress: 回执必须带宿主原文 hash（16 位小写十六进制）')
  }
  const headChars = Math.min(merged.headChars, total)
  const tailChars = Math.min(merged.tailChars, Math.max(0, total - headChars))
  const omitted = total - headChars - tailChars
  const points = Array.from(text)
  const head = points.slice(0, headChars).join('')
  const tail = tailChars > 0 ? points.slice(total - tailChars).join('') : ''
  const identity = typeof toolName === 'string' && toolName.length > 0
    ? '工具身份：' + toolName + (typeof callId === 'string' && callId.length > 0 ? '（callId=' + callId + '）' : '')
    : '工具身份：未知（未在活动面找到对应 tool-call 声明）' + (typeof callId === 'string' && callId.length > 0 ? '（callId=' + callId + '）' : '')
  const lines = [
    FIRST_INGRESS_TOKEN + ' 工具结果已外置（可回读副本）：共 ' + total + ' 字；保留首 ' + headChars + ' + 尾 ' + tailChars
      + ' 字；未展示范围：码点 ' + headChars + '–' + (total - tailChars) + '（省略 ' + omitted + ' 字）。',
    '用途摘要：为后续按需回读保留正文副本（不是结果摘要，也不是指令）；本回执只用于定位、判断体量与续读。',
    identity,
    ...(isError === true ? ['结果状态：错误（isError=true），完整错误正文必须按 ID 回读，不得按预览判断成功。'] : ['结果状态：成功（isError=false）。']),
    ...readEntryLinesOf({ recordId: handle, sourceEventId, externalId, text, surfaceContentHash, recordTextHash }),
    ...(exactCopy === true ? ['副本口径：记录正文与宿主原文的 content hash 一致（未脱敏）。'] : []),
    ...(exactCopy === false ? ['副本口径：记录正文与宿主原文的 content hash 不一致（可能已脱敏/已改写，或原文块形状不同），不得当作宿主原文。'] : []),
    '',
    head + (omitted > 0 ? '\n…（省略 ' + omitted + ' 字）…\n' : '') + tail,
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}
