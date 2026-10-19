/**
 * 权威状态记录（P0-3）：命令被拒绝时，面板不得显示已生效。
 *
 * 宿主把每次斜杠命令都记成 command/run，投影只能按命令行折叠，看不出这次
 * 调用到底成没成。于是「关闭降温」被维护窗口拒绝（返回红字、持久状态一个字节
 * 没动）时，面板照样翻成已关闭——界面与真实状态相反。
 *
 * 修法：状态类命令结束后（**成功或失败都写**）追加一条插件记录，值取自当时
 * 的真实状态而不是命令意图；投影折叠到它时直接覆盖开关位。记录排在
 * command/run 之后，天然后写覆盖前写，重放（resume/fork）同样生效。
 *
 * 宿主能力缺失时（旧版本没有 appendPluginRecord）不写、也不抛：调用方如实
 * 说明并退回按命令行折叠，绝不假装写过。
 */
import { createRequire } from 'node:module'

/** 记录类型：包名命名空间，符合宿主的 plugin: 语法。 */
export const STATE_RECORD_TYPE = 'plugin:dsh-memory-context-lab/state'

/** 权威记录里承载开关位的字段名；与 viewOf 的字段同名，折叠时直接覆盖。 */
export const STATE_RECORD_FIELDS = Object.freeze([
  'enabled',
  'engine',
  'fullHistory',
  'planFirst',
  'hierarchyCompress',
  'compressModel',
  'shareL2Content',
  'auto',
  'autoRecall',
  'autoRestore',
  'retainOperations',
  'archiveBatchSize',
  // 0.13.1：闸门阈值。权威记录的意义是「命令被拒绝时面板不得显示已生效」，
  // 闸门也必须受同一约束，否则被拒绝的 set pressure 仍会停在面板上。
  'pressureGate',
])

let cachedModule
let cachedError = null

/**
 * 解析宿主的 session 模块。
 *
 * 插件装在 profile 的 node_modules 下，@deepseek-ai/dsh-session 不在它的解析
 * 路径里；先试插件自身的解析，再试调用方给的 requireFromPlugin（index.mjs 用它
 * 解析 schemastery），最后试进程入口所在安装。
 *
 * @returns {{module: object} | {module: null, reason: string}}
 */
export function loadHostSessionModule(options) {
  const requireFromPlugin = options?.requireFromPlugin
  if (cachedModule) return { module: cachedModule }
  if (cachedError) return { module: null, reason: cachedError }
  const attempts = []
  const tryRequire = (requireFn, label) => {
    if (typeof requireFn !== 'function') return null
    try {
      return requireFn('@deepseek-ai/dsh-session')
    } catch (error) {
      attempts.push(label + ':' + (error?.code ?? error?.message ?? 'unknown'))
      return null
    }
  }
  const loaders = [
    () => createRequire(import.meta.url),
    () => requireFromPlugin,
    () => createRequire(process.argv[1] ?? process.cwd() + '/'),
  ]
  for (const loader of loaders) {
    let requireFn
    try {
      requireFn = loader()
    } catch (error) {
      attempts.push('loader:' + (error?.message ?? 'unknown'))
      continue
    }
    const loaded = tryRequire(requireFn, 'require')
    if (loaded && typeof loaded.appendPluginRecord === 'function') {
      cachedModule = loaded
      return { module: loaded }
    }
  }
  cachedError = '宿主未提供 appendPluginRecord（' + attempts.join('; ') + '）'
  return { module: null, reason: cachedError }
}

/** 测试用：直接注入一个宿主模块替身（不触碰真实安装）。 */
export function __setHostSessionModuleForTest(module) {
  cachedModule = module ?? undefined
  cachedError = null
}

/** 测试用：清掉模块缓存。 */
export function resetHostSessionModuleCache() {
  cachedModule = undefined
  cachedError = null
}

/**
 * 从真实记录/引擎状态里取开关位。
 *
 * 只认记录自己的状态，不认命令意图：命令被拒绝时记录没变，这里读到的就是
 * 「仍然开着」。
 *
 * **只表态账本真的持有的字段**（0.12.0 修复）：v1 账本没有 `fullHistory`、
 * `compressModel` 等 v2 专属位；v2 账本也不一定持有 `planFirst`（面板的计划
 * 先行行走的是 `/memory-lab set planfirst`，v2 账本只在 `/memory-lab2 set
 * planfirst` 时才有这一位）。旧实现按「缺省 false」补齐，于是每写一条权威记录
 * 就把这些位压回关——面板开关闪一下又关掉。现在缺席即「本记录不表态」，投影
 * 保留日志折叠出来的值。
 *
 * **v2 专属位在 v2 不持有时就是关**：全历史、层级压缩、压缩模型、层级卡共享正文
 * 都只有 v2 引擎能实现。v2 一停用（无论是 `/memory-lab2 off` 还是面板把
 * `/memory-lab off` 转交给 v2），这几位就是确定性的 false，必须写出来——否则
 * 面板会停在「降温已停用、全历史仍显示开」，再点该开关只会得到「v2 引擎未启用」，
 * 看起来就是「关不了」。
 */
export function stateRecordDataOf({ enabled, engine, state } = {}) {
  const holding = engine === 'v1' || engine === 'v2' ? engine : ''
  const data = { enabled: enabled === true, engine: holding }
  const source = state && typeof state === 'object' ? state : null
  // v2 专属位：v2 不持有投影时一律关（事实，不是默认值）。
  for (const field of ['fullHistory', 'hierarchyCompress', 'compressModel', 'shareL2Content']) {
    if (holding === 'v2' && typeof source?.[field] === 'boolean') data[field] = source[field]
    else if (holding !== 'v2') data[field] = false
  }
  // 插件级开关：只有账本记着才表态（v1 账本与 v2 账本都可能持有它）。
  if (typeof source?.planFirst === 'boolean') data.planFirst = source.planFirst
  const settings = source?.settings && typeof source.settings === 'object' ? source.settings : null
  if (settings) {
    for (const key of ['auto', 'autoRecall', 'autoRestore']) {
      if (typeof settings[key] === 'boolean') data[key] = settings[key]
    }
    if (Number.isInteger(settings.retainOperations)) data.retainOperations = settings.retainOperations
    if (Number.isInteger(settings.archiveBatchSize)) data.archiveBatchSize = settings.archiveBatchSize
    if (Number.isInteger(settings.pressureGate)) data.pressureGate = settings.pressureGate
  }
  return data
}

/**
 * 追加一条权威状态记录。
 *
 * @returns {{ok: true, seq: number} | {ok: false, reason: string}}
 */
export function appendStateRecord(session, data, options) {
  const requireFromPlugin = options?.requireFromPlugin
  const loaded = loadHostSessionModule({ requireFromPlugin })
  if (!loaded.module) return { ok: false, reason: loaded.reason }
  if (!session || typeof session.append !== 'function') {
    return { ok: false, reason: '当前会话不支持追加插件记录' }
  }
  try {
    const seq = loaded.module.appendPluginRecord(session, STATE_RECORD_TYPE, data)
    return { ok: true, seq }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从一条已提交事件里读权威状态。
 *
 * @returns {object | null} 命中的开关位；不是本插件的状态记录时返回 null。
 */
export function stateRecordOf(event, options) {
  if (!event || event.type !== STATE_RECORD_TYPE) return null
  const loaded = loadHostSessionModule(options)
  if (loaded.module && typeof loaded.module.pluginRecordOf === 'function') {
    const record = loaded.module.pluginRecordOf(event)
    if (!record) return null
    return sanitizeStateRecord(record.data)
  }
  // 宿主模块不可用时按事件自身形状读：类型已经精确匹配，载荷仍是插件写的。
  return sanitizeStateRecord(event.data)
}

/** 只取已知字段并做类型收敛；一个已知字段都没有时返回 null（旧记录按未记录处理）。 */
export function sanitizeStateRecord(data) {
  if (!data || typeof data !== 'object') return null
  const out = {}
  let seen = 0
  const flags = ['enabled', 'fullHistory', 'planFirst', 'hierarchyCompress', 'compressModel', 'shareL2Content', 'auto', 'autoRecall', 'autoRestore']
  for (const field of STATE_RECORD_FIELDS) {
    if (!(field in data)) continue
    const value = data[field]
    if (flags.includes(field)) {
      out[field] = value === true
      seen += 1
    } else if (field === 'engine') {
      out[field] = value === 'v1' || value === 'v2' ? value : ''
      seen += 1
    } else if (field === 'retainOperations' || field === 'archiveBatchSize') {
      if (!Number.isInteger(value) || value < 0) continue
      out[field] = value
      seen += 1
    } else if (field === 'pressureGate') {
      // 越界即丢弃（失败关闭）：宁可不表态，也不写一个越界的阈值进记录。
      if (!Number.isInteger(value) || value < 0 || value > 95) continue
      out[field] = value
      seen += 1
    }
  }
  return seen > 0 ? out : null
}