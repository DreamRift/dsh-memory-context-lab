/**
 * v2 设置写入域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：`/memory-lab set <键> <值>` 的全部键位与校验。
 * 函数体逐字搬移，语义零改动。
 *
 * ## 装配契约
 * `createSettingsDomain({ records, engine, adopt, logger, sessionIdOf, onPlanFirstToggle })`。
 *
 * ## 不变量
 * 设置必须落盘（`writeV2SessionState`）——只改内存会让「设置成功」在重启后
 * 失效。设置键是**闭集**：未登记的键一律报用法错误，不静默忽略。
 *
 * 键位清单只有一处权威：`SETTING_KEYS`。错误提示、帮助文本与 README 的键位表
 * 都由它派生或与它比对（守卫见 `test/settings-key-coverage.test.mjs`）——0.13.1
 * 之前错误提示是**手写的字符串**，删 v1 命令面时漏了 `autorestore`，于是面板
 * 那个开关点下去会被回「未知设置项」，而提示里列出的键位又不含它。
 */
import { NUMERIC_SETTINGS, normalizeSettings, restoreGrowth } from '../core.mjs'
import { describeRestoreSkipReasons } from '../apply.mjs'
import { writeV2SessionState } from './state.mjs'

/**
 * `set` 接受的键位（闭集，顺序即帮助文本顺序）。
 *
 * `protect` 是**共享降温管线**的软保护预算：`apply-engine.mjs` 的
 * `refreshProtections` 每轮都从 `settings.protectBudgetTokens` 取值。v1 命令面
 * 删除后没有任何入口能写它，投影折叠却仍认这个键——面板显示改成功、运行时报
 * 「未知设置项」，是 0.13.1 遗漏的一处。这里补回，范围与
 * `core.mjs` 的 `NUMERIC_SETTINGS.protect`（0..2,000,000）一致。
 */
export const SETTING_KEYS = Object.freeze([
  'auto', 'recall', 'autorestore', 'batch', 'retain', 'readlease',
  'pressure', 'protect', 'fullhistory', 'planfirst', 'compress', 'compressmodel', 'sharel2content',
])

export function createSettingsDomain({
  records,
  engine,
  adopt,
  logger,
  sessionIdOf,
  onPlanFirstToggle,
}) {
  async function setSetting(invocation, args) {
    // 与 status/read 一致：重启后先接管磁盘上已启用的会话，否则「设置成功」在
    // 进程重启后会变成「未启用」——那是错的，会话在磁盘上确实是启用的。
    const record = records.get(sessionIdOf(invocation.agent.session)) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    const [key, rawValue] = args
    const settings = record.state.settings
    if (key === 'auto' || key === 'recall') {
      const target = key === 'auto' ? 'auto' : 'autoRecall'
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: `用法：\`/memory-lab set ${key} on|off\`` }
      }
      settings[target] = rawValue === 'on'
    } else if (key === 'autorestore') {
      // 停用时是否恢复原文。引擎侧在 disable 路径读 settings.autoRestore（见
      // runtime-lifecycle 的窗口守卫分支），面板的开关一直发这条命令——0.13.1
      // 删 v1 命令面时漏了这个键，导致开关点了只回「未知设置键」。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set autorestore on|off`' }
      }
      settings.autoRestore = rawValue === 'on'
    } else if (key === 'batch' || key === 'retain') {
      const target = key === 'batch' ? 'archiveBatchSize' : 'retainOperations'
      const value = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isInteger(value) || value < 1 || value > NUMERIC_SETTINGS[key].max) {
        return { kind: 'error', text: `用法：\`/memory-lab set ${key} <1..${NUMERIC_SETTINGS[key].max} 的整数>\`` }
      }
      settings[target] = value
    } else if (key === 'readlease') {
      // 0.12.0 P0-3：读取租约长度（0 = 关闭）。0 必须可用——它是「退回旧行为」的
      // 唯一入口；上界与 NUMERIC_SETTINGS.readlease 一致（50），越界不静默夹取。
      const value = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isInteger(value) || value < 0 || value > 50) {
        return { kind: 'error', text: '用法：`/memory-lab set readlease <0..50 的整数>`（0 = 关闭读取租约）' }
      }
      settings.retainReads = value
    } else if (key === 'protect') {
      // 软保护预算（估算 token）：0 = 只保留硬保护。上界与 NUMERIC_SETTINGS.protect
      // 一致（2,000,000），越界不静默夹取。
      const value = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isInteger(value) || value < 0 || value > 2_000_000) {
        return { kind: 'error', text: '用法：`/memory-lab set protect <0..2000000 的整数>`（软保护预算，估算 token）' }
      }
      settings.protectBudgetTokens = value
    } else if (key === 'pressure') {
      // 0.13.0 压力闸门：0 = 无压力也降温（旧行为），1..95 = 占用率达到该百分比才归档。
      // 0 必须可用——它是「退回旧行为」的唯一入口。
      const value = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isInteger(value) || value < 0 || value > 95) {
        return { kind: 'error', text: '用法：`/memory-lab set pressure <0..95 的整数>`（0 = 无压力也降温）' }
      }
      settings.pressureGate = value
      // 改阈值即重置滞回状态：否则旧状态会让新阈值的第一步按旧窗口裁决。
      record.state.pressureCoolingOn = false
      record.state.pressureSamples = []
    } else if (key === 'fullhistory') {
      // 全历史记忆上下文：独立于 settings 五字段存在（normalizeSettings 会把它剥掉），
      // 引擎按 record.state.fullHistory 读取。开启即代表「除不可压缩凭证外全部退热」，
      // 「保留最近操作」同时失效（面板输入框变灰）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set fullhistory on|off`' }
      }
      // rc.5：off 先恢复原文再翻开关位——已归档的操作不能以回执形态留在投影里
      // 却宣称「全历史已关」。恢复失败不阻断关闭（与 v2 off 同语义），如实逐条报告。
      // 窗口守卫与停用同口径：overflow 则跳过恢复但开关照翻，如实给出路。
      const restoreNotes = []
      let fullHistoryGuardRefusal = null
      if (rawValue === 'off' && record.state.fullHistory === true) {
        // P0-2：待恢复行与跳过行合并计数——两者恢复到活动面的增量同源，
        // 窗口守卫只看总量，不看上次尝试的成败。
        const restoreRows = [...engine.pendingReceipts(record), ...engine.restoreSkippedReceipts(record)]
        const pendingCount = restoreRows.length
        if (pendingCount > 0) {
          try {
            const occupancy = await engine.measureOccupancy(record, undefined)
            const growth = restoreGrowth(restoreRows, {
              assembledTokens: occupancy.host.assembledTokens,
              contextWindow: occupancy.host.contextWindow,
            })
            if (growth.overflow) {
              fullHistoryGuardRefusal = {
                total: growth.total,
                heldByReceipts: growth.heldByReceipts,
                assembled: occupancy.host.assembledTokens,
                window: occupancy.host.contextWindow,
              }
            }
          } catch (error) {
            logger?.warn?.(`memory-context-lab: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (fullHistoryGuardRefusal) {
          const growth = fullHistoryGuardRefusal.total - (fullHistoryGuardRefusal.heldByReceipts ?? 0)
          restoreNotes.push(
            `已关闭全历史，但恢复会让组装输入超出模型窗口（当前约 ${fullHistoryGuardRefusal.assembled} + 待恢复约 ${growth} > 窗口 ${fullHistoryGuardRefusal.window}），`,
            '因此**没有**恢复，原文仍在冷库里。要取回原文，请先缩小上下文后再 /memory-lab restore，或直接丢弃冷库：',
            '  /memory-lab clean confirm delete-session',
          )
        } else {
          try {
            const outcome = await engine.runRestore(record)
            const restored = outcome?.restored ?? 0
            const before = outcome?.before ?? 0
            if (before > 0) restoreNotes.push(`已恢复 ${restored}/${before} 段原文。`)
            const stillSkipped = outcome?.stillSkipped ?? 0
            if (stillSkipped > 0) {
              // N-07：同 `off` 回执——「原因见逐条结局」而本回执并没有逐条结局，
              // 等于把原因丢掉。这里给出「原因 × 段数」的聚合清单。
              const why = describeRestoreSkipReasons(outcome?.skippedReasons)
              restoreNotes.push(`仍有 ${stillSkipped} 段原文未恢复（restore 跳过）${why ? `，原因：${why}` : '（原因未取得，可 /memory-lab status 复核）。'}它们的正文仍在冷库里，历史与载荷按只读保留，旧记录 ID 仍可回读。`)
            }
          } catch (error) {
            restoreNotes.push(`恢复未完成：${error instanceof Error ? error.message : String(error)}；` +
              '可稍后用 /memory-lab restore 重试（历史按只读保留，旧记录 ID 仍可回读）。')
          }
        }
      }
      record.state.fullHistory = rawValue === 'on'
      if (record.state.fullHistory) {
        settings.retainOperations = normalizeSettings(settings).retainOperations
      }
      record.state.settings = normalizeSettings(settings)
      // 设置必须落盘：只改内存会让「设置成功」在重启后失效，而 v1 的 set 是持久的。
      await writeV2SessionState(record.directory, record.state)
      const lines = [`全历史记忆上下文已设为 ${rawValue === 'on' ? '开' : '关'}（写入 v2 账本）。`]
      lines.push(...restoreNotes)
      return { kind: 'success', text: lines.join('\n') }
    } else if (key === 'compress') {
      // 层级压缩开关（P3）：默认关；开启后自动降温收尾会尝试对连续已完成回执组
      // 做聚合凭证替换（preview 不受开关影响，任何时候都可只读预览）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set compress on|off`' }
      }
      record.state.hierarchyCompress = rawValue === 'on'
      await writeV2SessionState(record.directory, record.state)
      return { kind: 'success', text: `层级压缩已设为 ${rawValue === 'on' ? '开' : '关'}（默认关；可用 /memory-lab compress preview 先行预览）。` }
    } else if (key === 'compressmodel') {
      // 层级压缩模型模式开关（P4）：只在 compress 已开时有实效；模型不可用或
      // 产出不合格时自动落回程序摘要（失败关闭），这里只记偏好位。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set compressmodel on|off`' }
      }
      record.state.compressModel = rawValue === 'on'
      await writeV2SessionState(record.directory, record.state)
      const note = record.state.compressModel
        ? '已设为开：聚合摘要将先经模型改写（注入的 stream 契约），失败或校验不过时自动落回程序摘要。'
        : '已设为关：聚合摘要直接用程序版本。'
      return { kind: 'success', text: `层级压缩模型模式已设为 ${rawValue === 'on' ? '开' : '关'}。${note}` }
    } else if (key === 'sharel2content') {
      // T1/F-03：层级卡共享正文摘录。默认关：卡里只给属性、来源与展开入口，
      // 不复制成员正文。开启后 L1/L2 卡才带摘录。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set sharel2content on|off`' }
      }
      record.state.shareL2Content = rawValue === 'on'
      record.state.settings = normalizeSettings(settings)
      await writeV2SessionState(record.directory, record.state)
      return {
        kind: 'success',
        text: record.state.shareL2Content
          ? '层级卡共享正文摘录已设为开：L1/L2 卡会带成员正文片段。'
          : '层级卡共享正文摘录已设为关：L1/L2 卡只给属性与来源，正文用 expand/read 显式展开。',
      }
    } else if (key === 'planfirst') {
      // 插件级开关（与 /memory-lab set planfirst 同义）：v2 账本只记位置，
      // 联动动作由注入的回调执行（服务缺失时回调返回提示，不阻断）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab set planfirst on|off`' }
      }
      record.state.planFirst = rawValue === 'on'
      // 回调可能返回 Promise 或普通对象（v1 的 enter/exitIfFresh 是 async，但不在
      // 手里兜底），统一经 Promise.resolve 吞错——退出失败不阻断开关位落账。
      const note = onPlanFirstToggle
        ? (await Promise.resolve(onPlanFirstToggle(invocation.agent, rawValue === 'on')).catch(() => null))
        : null
      record.state.settings = normalizeSettings(settings)
      await writeV2SessionState(record.directory, record.state)
      const lines = [`新会话计划先行已设为 ${rawValue === 'on' ? '开' : '关'}（写入 v2 账本）。`]
      if (note) lines.push(note.text)
      return { kind: 'success', text: lines.join('\n') }
    } else {
      return { kind: 'error', text: `未知设置项 ${key ?? ''}；支持 ${SETTING_KEYS.join('|')}。` }
    }
    record.state.settings = normalizeSettings(settings)
    // 设置必须落盘：只改内存会让「设置成功」在重启后失效，而 v1 的 set 是持久的。
    await writeV2SessionState(record.directory, record.state)
    return { kind: 'success', text: `已设置 ${key}=${rawValue}（写入 v2 账本，重启后仍生效）。` }
  }

  return {
    setSetting,
  }
}
