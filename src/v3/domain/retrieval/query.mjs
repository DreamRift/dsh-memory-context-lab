/**
 * 检索域纯函数（domain/retrieval，M1）——P6 检索三件套的域侧地基：
 * - 查询规范化：CJK 单字 + 相邻双字、ASCII 词小写化；
 * - 双面 min_score 门槛：结果面（给模型看的命中）与装包面（够格进回注包的命中）
 *   分开设阈——「纯壳命中」不因门槛单一而混进回注（recall-gate 保留判据的域侧形态）；
 * - 确定性排序：分数降序、同分按 id 升序——同输入同输出，可重放（P4/§2.7）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 查询规范化：返回词元序列。
 * - CJK 连续段：每个单字一个词元，相邻两字再生成双字词元；
 * - 非 CJK 连续段：小写化的词（字母/数字序列）；
 * - 空白/标点切断；空查询返回空数组（由调用方失败关闭，不在这里造通配）。
 */
export function tokenizeQuery(raw) {
  if (typeof raw !== 'string') {
    throw new V3ContractViolation('v3 retrieval: 查询必须是字符串')
  }
  const terms = []
  let buffer = ''
  const flushWord = () => {
    if (buffer.length > 0) {
      terms.push(buffer.toLowerCase())
      buffer = ''
    }
  }
  const cjkRun = []
  const flushCjk = () => {
    if (cjkRun.length > 0) {
      for (const ch of cjkRun) terms.push(ch)
      for (let i = 0; i + 1 < cjkRun.length; i += 1) terms.push(cjkRun[i] + cjkRun[i + 1])
      cjkRun.length = 0
    }
  }
  for (const ch of raw) {
    if (CJK.test(ch)) {
      flushWord()
      cjkRun.push(ch)
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      flushCjk()
      buffer += ch
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return terms
}

/**
 * 双面 min_score 门槛。
 *
 * @param {Array<{id: string, score: number}>} results 已排序或未排序命中
 * @param {{ resultMinScore: number, packMinScore: number }} thresholds 两面阈值（有限数 ≥0）
 * @returns {{ display: object[], pack: object[], dropped: object[] }}
 *   display = 结果面（≥ resultMinScore）；pack = 装包面（≥ packMinScore，是 display 的子集）；
 *   dropped = 低于结果面阈值的（如实分离，不静默吞掉计数）。
 */
export function applyMinScore(results, { resultMinScore, packMinScore } = {}) {
  if (!Array.isArray(results)) {
    throw new V3ContractViolation('v3 retrieval: results 必须是数组')
  }
  for (const [name, value] of [['resultMinScore', resultMinScore], ['packMinScore', packMinScore]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new V3ContractViolation('v3 retrieval: ' + name + ' 必须是有限非负数（未知阈值失败关闭，不默认放行）')
    }
  }
  if (packMinScore < resultMinScore) {
    throw new V3ContractViolation('v3 retrieval: packMinScore 不得低于 resultMinScore（装包面阈只会更严）')
  }
  for (const item of results) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score)) {
      throw new V3ContractViolation('v3 retrieval: 命中项必须是 {id: string, score: number}')
    }
  }
  const display = results.filter((r) => r.score >= resultMinScore)
  const pack = results.filter((r) => r.score >= packMinScore)
  const dropped = results.filter((r) => r.score < resultMinScore)
  return { display, pack, dropped }
}

/**
 * 确定性排序：score 降序，同分 id 升序。不修改入参。
 */
export function rankResults(results) {
  if (!Array.isArray(results)) {
    throw new V3ContractViolation('v3 retrieval: results 必须是数组')
  }
  return [...results].sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
