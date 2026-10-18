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
  'auto',
  'autoRecall',
  'autoRestore',
  'retainOperations',
  'archiveBatchSize',
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
 */
export function stateRecordDataOf({ enabled, engine, state } = {}) {
  const settings = state?.settings ?? {}
  return {
    enabled: enabled === true,
    engine: engine === 'v1' || engine === 'v2' ? engine : '',
    fullHistory: state?.fullHistory === true,
    planFirst: state?.planFirst === true,
    hierarchyCompress: state?.hierarchyCompress === true,
    compressModel: state?.compressModel === true,
    auto: settings.auto !== false,
    autoRecall: settings.autoRecall !== false,
    autoRestore: settings.autoRestore !== false,
    retainOperations: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 0,
    archiveBatchSize: Number.isInteger(settings.archiveBatchSize) ? settings.archiveBatchSize : 10,
  }
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
  const flags = ['enabled', 'fullHistory', 'planFirst', 'hierarchyCompress', 'compressModel', 'auto', 'autoRecall', 'autoRestore']
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
    }
  }
  return seen > 0 ? out : null
}