/**
 * B3-9（AUD50-04-04）：状态/控制读取的目录级新鲜度闸门（control/state 共用此唯一实现）。
 *
 * 每 tick 的 view 重算会对 control.json / state.json 各做一次 statSync（每事件 2 次、
 * 100 事件 ~7ms）。这两份文件在本仓库只经 writeFileAtomic（temp+rename）写入——目录
 * mtime 必然推进。以**目录 mtime** 为闸门：目录没变 → 调用方直接用进程内文件缓存
 * （0 次文件 stat）；变了 → 走逐文件戳校验。同一同步批次内的多次检查共享一次目录
 * stat（statusOf 一次 view 同时读 control+state；微任务边界自动失效，不跨事件复用）。
 *
 * 边界：绕过 rename 的原地改写不推进目录 mtime，本闸门看不到——本仓库全部写入都走
 * writeFileAtomic；外部工具原地改文件属于 fileExists 同款「外部修改」边界，不承诺。
 * 目录缺失（会话目录还没建）→ 闸门返回 false，走调用方正常 ENOENT 路径。
 */
import { statSync } from 'node:fs'

const gates = new Map() // dir → 最近一次观察到的目录 mtimeMs
const gateStats = { stats: 0, hits: 0 }

// 同步批次共享：statusOf 一次 view 里 control/state 各查一次闸门，只该花 1 次 stat。
// statSync 是同步调用，批次在下一个微任务自然结束——用 queueMicrotask 清尾，
// 不跨异步边界复用（跨 tick 的 staleness 风险为零）。
let sweep = null

/** 测试/诊断用：闸门 stat 计数（守卫测试断言「每 tick 至多 1 次目录 stat」）。 */
export function _sessionDirGateStats() { return { ...gateStats } }

/**
 * 目录自上次观察以来是否未变。true = 调用方可直接使用进程内文件缓存；
 * false = 走逐文件戳校验（含首次观察/目录变化/目录缺失）。
 */
export function sessionDirFresh(dir) {
  if (sweep !== null && sweep.dir === dir) {
    gateStats.hits += 1
    return sweep.fresh
  }
  gateStats.stats += 1
  let mtime
  try {
    mtime = statSync(dir).mtimeMs
  } catch (error) {
    if (error?.code === 'ENOENT') {
      gates.delete(dir)
      sweep = { dir, fresh: false }
      queueMicrotask(() => { sweep = null })
      return false
    }
    throw error
  }
  const known = gates.get(dir)
  const fresh = known !== undefined && known === mtime
  gates.set(dir, mtime)
  sweep = { dir, fresh }
  queueMicrotask(() => { sweep = null })
  return fresh
}
