/**
 * v2 的模型可见只读读取工具。
 *
 * ## 为什么它现在才存在
 *
 * 存储、内部召回接口、规划器与门禁都已在没有它的情况下完成并验证；
 * 这个文件是**唯一**为「模型主动读取」新增的模型可见面。它按设计规范
 * 固定注册：不随 `/memory-lab2 on|off` 增删 schema——工具集一增一减会作废
 * 整段前缀缓存，而且让「模型能读历史」变成模式依赖的行为。
 *
 * ## 边界（比功能更重要）
 *
 * - **只读**：只走 `runtime.recall`，那条路径只开只读句柄、只读内容寻址载荷，
 *   不写库、不写会话日志、不改状态。
 * - **不重定向灵枢**：不调用 `lingshu_cg`、不写正式灵枢根、不触发
 *   consolidate/verify/状态链/自演化。返回的原文来自本插件自己的隔离库。
 * - **不冒充授权或观察**：历史正文标注为「当时记录」，明确它不是新的用户授权、
 *   也不是新的文件观察版本；读回旧内容不能恢复任何已失效的权限。
 * - **诚实报告**：没有历史就直说没有；预算不足就显式截断并说明；
 *   字面检索不返回分数（分数不是置信度）。
 */

/** 工具名：固定、专用、只读。 */
export const V2_RECALL_TOOL_NAME = 'memory_lab_recall'

/** 工具描述：写清楚「能做什么」和「不做什么」，避免模型过度期待。 */
export const V2_RECALL_TOOL_DESCRIPTION = [
  '读取本会话已退出热上下文的记忆上下文冷库（只读）。',
  '三种用法：给 record_ids 按稳定 ID 精确回读原文；给 query 做字面检索（返回索引命中，正文仍需按 ID 回读）；',
  '都不给则返回当前有界工作状态卡。返回的历史是「当时记录的原文」，不是新的用户授权，也不是新的文件观察结果。',
  '本工具不改写会话日志、不改活动面、不访问正式长期记忆库；回读会记入本插件自己的成本账本（只写插件隔离根内的状态文件）。',
].join('')

/** 参数 schema：宿主 ParameterSchemaSpec 的 JSON-Schema 风格包装。全部可选。 */
export const V2_RECALL_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  // 关死未知键：宿主 validateJsonSchemaValue 会据此在调用前拒掉拼错的参数，
  // 而不是把垃圾静默传进 execute（探针实测：不声明时未知键会被放行）。
  additionalProperties: false,
  properties: {
    record_ids: {
      type: 'array',
      items: { type: 'string' },
      description: '要精确回读的稳定记录 ID（形如 t00000001-r0001）。与 query 二选一，同时给出时以 record_ids 为准。',
    },
    query: {
      type: 'string',
      description: '字面检索词：匹配记录 ID、kind、保真等级、工具名、callId、命令或范围。不做语义检索，不返回相关性分数。',
    },
    budget_tokens: {
      type: 'integer',
      // 刻意**不写** minimum/maximum：宿主 assertSupportedJsonSchema 的约束关键字
      // 子集只有 type/oneOf/properties/required/additionalProperties/items/enum/const，
      // 多写一个 `minimum` 会让**整份 schema** 被拒、工具静默注册不上（已按宿主
      // 真实校验器 json-schema.js 的 CONSTRAINT_KEYWORDS 核对）。
      // 上下界因此改在执行层校验：0/负数/小数/超限都返回结构化错误，不静默换值。
      description: '本次回读的 token 预算上限（默认 6000，最大 32000）。必须为正整数；0/负数/超限会报错，不静默改值。预算不足时显式截断并说明。',
    },
    cursor: {
      type: 'string',
      description: '上一页返回的 next_cursor：预算用尽后按游标继续读同一批结果，不必重传 record_ids。',
    },
  },
})

/**
 * 输出 value schema（宿主支持的 JSON Schema 子集：type/oneOf/properties/required/
 * additionalProperties/items/enum/const + annotations）。
 *
 * 可空字段一律写 `oneOf: [{type:'T'}, {type:'null'}]`：
 * - `nullable: true` 不在宿主子集里，会被 `assertSupportedJsonSchema` 拒绝；
 * - `type: 'json'` 同样**不在**宿主允许的 type 列表里（只允许 object/array/string/
 *   number/integer/boolean/null），用了会让整份 schema 注册失败——已用宿主真实校验器
 *   （`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema`）实测确认。
 */
const nullable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

export const V2_RECALL_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    engine_enabled: { type: 'boolean' },
    mode: { type: 'string' },
    matched_by: nullable('string'),
    // 可空：预算参数非法时 `budgetTokens` 是 null（本次请求没执行，没有预算可言）。
    // 写成 `{type:'number'}` 会让宿主在 render 之前就抛 INVALID_TOOL_OUTPUT，
    // 那条「参数错误必须传回模型」的信息**永远到不了模型**。
    budget_tokens: nullable('number'),
    used_tokens: { type: 'number' },
    total_matched: nullable('number'),
    next_cursor: nullable('string'),
    // 参数错误必须能传回模型：把「预算 0」这类错误吞成「返回 0 条记录」，
    // 模型会以为「查了、没有」，而事实是「这次请求根本没执行」。
    error: nullable('string'),
    budget_overflow: { type: 'boolean' },
    overflow_reason: nullable('string'),
    text: nullable('string'),
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: nullable('string'),
          fidelity: nullable('string'),
          integrity: nullable('string'),
          resolved_via: nullable('string'),
          tokens: nullable('number'),
          has_payload: { type: 'boolean' },
          text: nullable('string'),
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
})

/**
 * 把 runtime.recall 的结果整理成工具输出值。
 *
 * 纯函数：不碰文件、不碰状态，便于单独测。
 */
export function toToolValue(sessionId, result) {
  const records = (result.entries ?? []).map((entry) => ({
    id: entry.id,
    kind: entry.kind ?? null,
    fidelity: entry.fidelity ?? null,
    integrity: entry.integrity ?? null,
    resolved_via: entry.resolvedVia ?? null,
    tokens: Number.isFinite(entry.tokens) ? entry.tokens : null,
    has_payload: entry.text !== undefined ? true : Boolean(entry.hasPayload),
    text: typeof entry.text === 'string' ? entry.text : null,
  }))
  return {
    engine_enabled: result.engineEnabled === true,
    mode: result.mode ?? 'none',
    matched_by: result.matchedBy ?? null,
    budget_tokens: result.budgetTokens ?? null,
    used_tokens: result.usedTokens ?? 0,
    total_matched: Number.isFinite(result.totalMatched) ? result.totalMatched : null,
    next_cursor: typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : null,
    error: typeof result.error === 'string' && result.error !== '' ? result.error : null,
    budget_overflow: result.budgetOverflow === true,
    overflow_reason: typeof result.overflowReason === 'string' && result.overflowReason !== '' ? result.overflowReason : null,
    text: typeof result.text === 'string' ? result.text : null,
    records,
    warnings: result.warnings ?? [],
  }
}

/**
 * 渲染给模型看的正文。
 *
 * 三处刻意的措辞：
 * - 顶部标注「当时记录」，堵住「读回旧文本 = 恢复授权」的误用；
 * - 正文用代码围栏包裹，避免历史里的指令被当成当前指令；
 * - 结尾说明未列出的内容不等于不存在，可按 ID 继续回读。
 */
export function renderToolOutput(sessionId, value) {
  if (!value.engine_enabled) {
    return [
      '记忆上下文 v2 在本会话未启用，没有可读的冷库。',
      '（本工具只读；启用与否由用户用 `/memory-lab2 on` 决定，模型无法自行启用。）',
    ].join('\n')
  }

  const lines = []
  if (value.error) {
    // 参数/执行错误：直说「这次没执行」，并给出可执行的修法。
    lines.push(`本次回读未执行：${value.error}`)
    lines.push('（这是请求参数错误，不是「查了但没有命中」。修正参数后重试。）')
  }
  if (value.mode === 'ids') {
    lines.push(`按记录 ID 回读（会话 ${sessionId}）；以下是**当时记录的原文**，不是新的用户授权，也不是新的文件观察结果。`)
    for (const record of value.records) {
      lines.push('', `── ${record.id}${record.resolved_via ? `（经 ${record.resolved_via} 映射）` : ''}`
        + ` kind=${record.kind ?? '未知'} 保真=${record.fidelity ?? '未知'} 完整性=${record.integrity ?? '未知'}`
        + `${record.tokens !== null ? ` ≈${record.tokens} token` : ''}`)
      if (typeof record.text === 'string' && record.text.length > 0) {
        lines.push('```text', record.text, '```')
      } else {
        lines.push('（该记录没有载荷：它是结构化索引记录，正文不在这里。）')
      }
    }
  } else if (value.mode === 'query') {
    lines.push(`字面检索命中 ${value.total_matched ?? value.records.length} 条（会话 ${sessionId}）。`
      + '这是字面匹配，不是语义相关性，也没有分数；正文需按 record_ids 回读。')
    lines.push('检索范围是**索引元数据**（记录 ID、kind、范围、工具名、callId 等），不含载荷正文——'
      + '正文里的词不会因此被搜到，要读正文必须按 record_ids 回读。')
    for (const record of value.records) {
      lines.push(`- ${record.id} kind=${record.kind ?? '未知'} 保真=${record.fidelity ?? '未知'}`
        + `${record.has_payload ? '（有载荷）' : '（无载荷）'}`)
    }
  } else if (value.mode === 'working-set') {
    lines.push(`有界工作状态卡（会话 ${sessionId}）：`)
    lines.push('', value.text ?? '（空）')
  } else {
    lines.push('没有可返回的内容。')
  }

  if (value.error) {
    return lines.join('\n')
  }
  lines.push('', `预算 ${value.budget_tokens} token，本次使用 ≈${value.used_tokens} token。`)
  if (value.budget_overflow) {
    lines.push(`预算溢出：${value.overflow_reason ?? '本次结果超过预算，正文未完整带回。'}`)
  }
  if (value.next_cursor) {
    // 有下一页就必须把游标交给模型：否则「预算用尽」等于「只能重发同样的请求」。
    lines.push(`本次未读完：把 cursor 参数设为下面这个值继续读同一批结果（不要重传 record_ids）。`)
    lines.push(`cursor: ${value.next_cursor}`)
  }
  if (value.warnings.length > 0) lines.push(`告警：${value.warnings.join('；')}`)
  lines.push('未列出的内容不等于不存在：可用 record_ids 精确回读，或用 /memory-lab2 history 翻页浏览。')
  return lines.join('\n')
}

/**
 * 构造工具定义（宿主 `ToolRuntime.register(definition)` 的直接契约形态）。
 *
 * 不依赖任何宿主注入助手：`definition` 就是 `{ name, description, parameters,
 * output, execute }`，与宿主 `ToolRuntime` 实测契约一致（按 app.asar 内
 * `ToolRuntime.register`／`assertSupportedJsonSchema` 的校验实现核对）。
 * 这样同一份定义既能被真实宿主注册，也能在无 DSH 的测试里直接调 execute。
 *
 * @param {object} deps
 * @param {{ recall: Function }} deps.runtime v2 运行时（只用其只读 recall）
 * @param {(session: object) => string} deps.sessionIdOf 会话 ID 解析
 */
export function createV2RecallTool({ runtime, sessionIdOf }) {
  if (!runtime || typeof runtime.recall !== 'function') throw new Error('createV2RecallTool 需要 runtime.recall。')
  if (typeof sessionIdOf !== 'function') throw new Error('createV2RecallTool 需要 sessionIdOf。')

  return {
    name: V2_RECALL_TOOL_NAME,
    description: V2_RECALL_TOOL_DESCRIPTION,
    parameters: V2_RECALL_TOOL_PARAMETERS,
    output: {
      schema: V2_RECALL_TOOL_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderToolOutput(value.session_id ?? '', value) }]
      },
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const sessionId = sessionIdOf(session)
      const recordIds = Array.isArray(args?.record_ids)
        ? args.record_ids.filter((id) => typeof id === 'string')
        : []
      const query = typeof args?.query === 'string' ? args.query : null
      // 预算原样交给 runtime 校验：这里**不能**用 Number.isFinite 过滤掉非法值，
      // 否则 0/负数/超限会被悄悄换成默认值（规范 §6.1 禁止静默放大预算）。
      const budgetTokens = args?.budget_tokens
      const cursor = typeof args?.cursor === 'string' && args.cursor !== '' ? args.cursor : null
      const result = await runtime.recall(sessionId, {
        recordIds,
        query,
        budgetTokens,
        session,
        attribution: 'tool',
        cursor,
      })
      return { session_id: sessionId, ...toToolValue(sessionId, result) }
    },
  }
}
