/**
 * P4 固定三工具（0.15.0）：
 * - 名称/参数/输出 schema 固定，且只使用宿主 0.2.1-rc.5 已核实的关键字；
 * - 参数校验是**本插件自己的** validateToolArguments（宿主 raw register 不校验 args，
 *   也不在调用前按 additionalProperties:false 拒绝未知参数）；execute 必须真的拒绝；
 * - 晚就绪：ctx.get('tools') 为空时订阅注入，服务可用后注册三工具且只注册一次；
 * - 工具描述与结果来源标记固定（结果不回灌检索的判据之一）；
 * - 引擎缺失时仍是同一定义，降级只通过返回值表达（工具集恒定）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_CONTEXT_TOOL_LIST,
  MEMORY_CONTEXT_TOOL_NAMES,
  OWN_TOOL_RESULT_MARKER,
  SEARCH_COMPLETENESS,
  SEARCH_OFFSET_UNIT,
} from '../src/v3/contracts/tools.mjs'
import { READ_REFERENCE_RELATIONS, READ_REFERENCE_STATUSES } from '../src/v3/contracts/citations.mjs'
import { READBACK_OFFSET_UNIT } from '../src/v3/contracts/readback.mjs'
import {
  createMemoryContextTools,
  memoryContextToolsRegistration,
  registerMemoryContextTools,
  validateToolArguments,
} from '../src/v3/entry/tools.mjs'

/** 宿主 assertSupportedJsonSchema 的关键字子集（dsh-tools 0.2.1-rc.5 源码核验）。 */
const ALLOWED_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function assertSchemaSubset(schema, at, errors) {
  if (schema === null || typeof schema !== 'object') {
    errors.push(at + ': schema 必须是对象')
    return
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) errors.push(at + ': 未知关键字 ' + key)
  }
  if (schema.type !== undefined && !ALLOWED_TYPES.has(schema.type)) errors.push(at + ': 非法 type ' + schema.type)
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSchemaSubset(child, at + '.' + name, errors)
  if (schema.items !== undefined) assertSchemaSubset(schema.items, at + '[]', errors)
  for (const [index, child] of (schema.oneOf ?? []).entries()) assertSchemaSubset(child, at + '|' + index, errors)
}

/** 参数校验 = 插件实现（不是宿主保证；宿主 raw register 不校验 args）。 */
const validateArgs = validateToolArguments

function fakeRegisterCtx() {
  const registered = []
  const ctx = {
    get(name) { return name === 'tools' ? toolsService : undefined },
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      callback({ tools: toolsService })
    },
    logger: { warn() {} },
  }
  const toolsService = { register(definition) { registered.push(definition); return () => {} } }
  return { ctx, registered }
}

test('三个工具的 schema 只使用宿主已核实关键字，且未知参数/错误类型被拒绝', () => {
  const definitions = createMemoryContextTools({ engine: null })
  assert.deepEqual(definitions.map((definition) => definition.name), MEMORY_CONTEXT_TOOL_LIST)
  assert.deepEqual(new Set(definitions.map((definition) => definition.name)), new Set(Object.values(MEMORY_CONTEXT_TOOL_NAMES)))
  for (const definition of definitions) {
    const errors = []
    assertSchemaSubset(definition.parameters, definition.name + '.parameters', errors)
    assertSchemaSubset(definition.output.schema, definition.name + '.output', errors)
    assert.deepEqual(errors, [], definition.name + ' schema 越界：' + errors.join('；'))
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
  const compact = definitions.find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.compact)
  // 未知参数键必须红（本插件自己的校验；宿主 raw register 不校验 args）
  assert.deepEqual(validateArgs(compact.parameters, { op: 'inspect', unexpected: 1 }).filter((row) => row.includes('未知参数')), ['arguments: 未知参数 unexpected'])
  assert.ok(validateArgs(compact.parameters, { op: 'inspect' }).length === 0)
  assert.ok(validateArgs(compact.parameters, { op: 'destroy' }).some((row) => row.includes('enum')))
  // 摘要草稿的未知字段同样拒绝
  assert.ok(validateArgs(compact.parameters, { op: 'prepare', summary: { shortText: 'x', mystery: true } }).some((row) => row.includes('未知参数 mystery')))
  assert.ok(validateArgs(compact.parameters, { op: 'prepare', summary: { shortText: 42 } }).some((row) => row.includes('需要 string')))
})

test('注册替身：固定名字、固定 schema、同内容二次构造逐字段相同（工具集恒定）', () => {
  const engine = { noteOwnToolCall() {} }
  const { ctx, registered } = fakeRegisterCtx()
  registerMemoryContextTools(ctx, { engine })
  assert.equal(registered.length, 3)
  const again = createMemoryContextTools({ engine })
  for (const definition of registered) {
    const twin = again.find((item) => item.name === definition.name)
    assert.deepEqual(definition.parameters, twin.parameters)
    assert.deepEqual(definition.output.schema, twin.output.schema)
    assert.equal(definition.description, twin.description)
  }
  // P2-1：无法等待时必须失败关闭，且状态可观测（不再打印「会自动注册」却什么都不做）。
  const bare = {
    get() { return undefined },
    inject() { throw new Error('inject 不可用') },
    logger: { warn() {} },
  }
  assert.deepEqual(registerMemoryContextTools(bare, { engine }), [])
  const bareStatus = memoryContextToolsRegistration(bare)
  assert.equal(bareStatus.phase, 'failed')
  assert.equal(bareStatus.reason, 'inject-failed')
  assert.equal(bareStatus.registered, 0)
})

test('晚就绪：先订阅 tools 注入，服务可用后注册三工具且只注册一次、schema 不变', () => {
  const engine = { noteOwnToolCall() {} }
  const registered = []
  const toolsService = { register(definition) { registered.push(definition); return () => {} } }
  let readyCallback = null
  const ctx = {
    get() { return undefined }, // 版本加载时 tools 服务尚未就绪
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      readyCallback = callback
    },
    logger: { warn() {} },
  }
  const disposers = registerMemoryContextTools(ctx, { engine })
  assert.deepEqual(disposers, [])
  assert.equal(registered.length, 0, '就绪前不得注册')
  const pending = memoryContextToolsRegistration(ctx)
  assert.equal(pending.phase, 'waiting', '必须处于真实等待态（不是静默返回）')
  assert.equal(pending.reason, 'tools-service-pending')

  assert.equal(typeof readyCallback, 'function', '必须真的订阅 tools 注入')
  readyCallback({ tools: toolsService })
  assert.deepEqual(registered.map((definition) => definition.name), [...MEMORY_CONTEXT_TOOL_LIST])
  const ready = memoryContextToolsRegistration(ctx)
  assert.equal(ready.phase, 'registered')
  assert.equal(ready.registered, 3)
  assert.deepEqual(ready.names, [...MEMORY_CONTEXT_TOOL_LIST])

  // 重复就绪回调 / 重复调用注册入口：都不得注册第二份（工具集恒定）。
  readyCallback({ tools: toolsService })
  registerMemoryContextTools(ctx, { engine })
  assert.equal(registered.length, 3, '三工具只能注册一次')

  // schema 与直接构造逐字段相同（注册路径不改定义）。
  const expected = createMemoryContextTools({ engine })
  for (const definition of registered) {
    const twin = expected.find((item) => item.name === definition.name)
    assert.deepEqual(definition.parameters, twin.parameters)
    assert.deepEqual(definition.output.schema, twin.output.schema)
    assert.equal(definition.description, twin.description)
  }
})

test('本地参数校验：未知参数/错型在 execute 入口被本插件拒绝（宿主不保证）', async () => {
  const [search, read, compact] = createMemoryContextTools({ engine: null })
  const exec = { callId: 'c-invalid', name: 'x', agent: { session: { id: 's1' } } }
  const badSearch = await search.execute({ query: 'q', unexpected: 1 }, exec)
  assert.equal(badSearch.status, 'disabled')
  assert.match(badSearch.error, /本插件本地校验/)
  assert.match(badSearch.error, /未知参数 unexpected/)
  const badRead = await read.execute({ id: 'v3r-0123456789abcdef', limit: 3 }, exec)
  assert.equal(badRead.visible, false)
  assert.match(badRead.error, /未知参数 limit/)
  const badCompact = await compact.execute({ op: 'destroy' }, exec)
  assert.equal(badCompact.status, 'rejected')
  assert.match(badCompact.error, /不在 enum 内/)
})

test('工具结果首行带 own-source 标记；引擎缺失时返回结构化 disabled 而不是抛错', async () => {
  const [search, read, compact] = createMemoryContextTools({ engine: null })
  const exec = { callId: 'c1', name: 'x', agent: { session: { id: 's1' } } }
  const searchValue = await search.execute({ query: 'q' }, exec)
  assert.equal(searchValue.status, 'disabled')
  const searchText = search.output.render({}, searchValue)[0].text
  assert.ok(searchText.startsWith(OWN_TOOL_RESULT_MARKER), '首行必须是 own-source 标记')
  const readValue = await read.execute({ id: 'v3r-0123456789abcdef' }, exec)
  assert.equal(readValue.visible, false)
  assert.ok(read.output.render({}, readValue)[0].text.startsWith(OWN_TOOL_RESULT_MARKER))
  const compactValue = await compact.execute({ op: 'inspect' }, exec)
  assert.equal(compactValue.committed, false, '未执行不得报 committed')
  assert.ok(compact.output.render({}, compactValue)[0].text.startsWith(OWN_TOOL_RESULT_MARKER))
})

test('accepted 文案不冒充完成：submit 的 render 明确「尚未压缩」', async () => {
  const engine = {
    noteOwnToolCall() {},
    async inspectCompact() { return { status: 'ok', stage: 'inspect', executable: true, candidate_id: 'cand-1', reasons: [] } },
    async submitCompact() {
      return { status: 'accepted', stage: 'submit', accepted: true, committed: false, proposal_id: 'v3p-1', candidate_id: 'cand-1', reasons: [], summary_id: null, receipt_seq: null }
    },
  }
  const compact = createMemoryContextTools({ engine }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.compact)
  const value = await compact.execute({ op: 'submit' }, { callId: 'c2', agent: { session: { id: 's1' } } })
  assert.equal(value.accepted, true)
  assert.equal(value.committed, false)
  const text = compact.output.render({}, value)[0].text
  assert.match(text, /accepted = 已持久化待执行，\*\*尚未压缩\*\*/)
})
/**
 * G1（0.15.0 搜索分页/命中摘录）：schema 的真源仍在 contracts/tools.mjs。
 *
 * 旧缺陷是「合同没有意见」——completeness 是自由字符串、没有偏移单位、命中项没有 span，
 * 于是「top-k 长度当 total」「只取前 160 码点」都不会被任何合同判红。本用例钉住：
 * 完整性枚举、偏移单位枚举、分页/摘录字段都在 schema 里，且参数面不变（前缀稳定）。
 */
test('G1：搜索 output schema 声明完整性枚举/偏移单位/摘录字段（参数面不变）', () => {
  const search = createMemoryContextTools({ engine: null }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.search)
  assert.deepEqual(search.output.schema.properties.completeness.enum, [...SEARCH_COMPLETENESS], 'completeness 必须是封闭集')
  assert.deepEqual(search.output.schema.properties.offset_unit.enum, [SEARCH_OFFSET_UNIT], '偏移单位必须进 schema')
  for (const field of ['total_match_count', 'reason', 'has_more', 'next_cursor', 'skipped_count', 'excerpt_version']) {
    assert.ok(Object.hasOwn(search.output.schema.properties, field), 'schema 缺少 ' + field)
  }
  const itemProperties = search.output.schema.properties.items.items.properties
  for (const field of ['excerpt_spans', 'excerpt_strategy', 'excerpt_truncated', 'excerpt_source', 'text_hash']) {
    assert.ok(Object.hasOwn(itemProperties, field), '命中项缺少 ' + field)
  }
  // 参数面不变：query 必填、cursor 仍是字符串（工具集/前缀不因分页而增删参数）
  assert.deepEqual(search.parameters.required, ['query'])
  assert.deepEqual(search.parameters.properties.cursor, { type: 'string' })
  assert.deepEqual(search.parameters.properties.limit, { type: 'integer' })
})

/**
 * G2（0.15.0 有界引用链/可靠回读）：读取**输出 schema** 是引用区与分页语义的单一真源。
 *
 * 旧缺陷是「schema 没有意见」——没有 sources/related/evidence_refs，也没有偏移单位与
 * 对象版本，于是「读回之后没有下一跳」「裸数字游标静默回第一页」都不会被任何合同判红。
 * 本用例只钉合同面：旧 9 字段与 required 不变、新增字段与 render 的固定信封同源、
 * 关系/状态是封闭集；行为面见 v3-g2-readback / v3-g2-failures。
 */
test('G2：读取 output schema 声明引用区与分页语义；旧字段/必填项/默认行为不变', () => {
  const read = createMemoryContextTools({ engine: null }).find((definition) => definition.name === MEMORY_CONTEXT_TOOL_NAMES.read)
  const properties = read.output.schema.properties
  // 旧字段一个都不能少（保留旧字段与默认行为）
  for (const field of ['status', 'id', 'type', 'source_hash', 'text', 'truncated', 'next_cursor', 'visible', 'error']) {
    assert.ok(Object.hasOwn(properties, field), '而旧字段 ' + field + ' 必须保留')
  }
  // 新增引用区/分页字段必须与 render 同源（缺一个就会让宿主 schema 校验失败）
  for (const field of [
    'offset_unit', 'cursor_version', 'object_version', 'object_version_kind', 'text_hash',
    'offset', 'returned_chars', 'reference_version', 'sources', 'related', 'evidence_refs',
    'refs_total', 'refs_truncated', 'refs_capped', 'next_refs_cursor',
  ]) {
    assert.ok(Object.hasOwn(properties, field), '引用区缺少 ' + field)
  }
  assert.deepEqual(read.output.schema.required, ['status', 'id', 'type', 'truncated', 'visible'], '必填项保持旧口径')
  assert.deepEqual(properties.offset_unit.enum, [READBACK_OFFSET_UNIT], '偏移单位唯一值 = 码点')
  // 引用对象：身份 + 关系 + 核验结果必填；关系/状态是封闭集（自由字符串会让两条链混起来）
  const reference = properties.sources.items
  assert.deepEqual(reference.required, ['id', 'kind', 'relation', 'status'])
  assert.deepEqual(reference.properties.relation.enum, [...READ_REFERENCE_RELATIONS])
  assert.deepEqual(reference.properties.status.enum, [...READ_REFERENCE_STATUSES])
  assert.equal(reference.additionalProperties, false, '引用对象也必须是闭合形状')
  // 参数面：旧参数都在，新增两个**可选**参数（不传即旧行为）
  assert.deepEqual(read.parameters.required, ['id'])
  for (const parameter of ['id', 'detail', 'cursor', 'offset', 'length', 'refs_cursor', 'refs_limit']) {
    assert.ok(Object.hasOwn(read.parameters.properties, parameter), '缺少参数 ' + parameter)
  }
  // 描述必须讲清分页单位、引用跳数、命令面例外（模型要能只靠描述正确使用）
  assert.match(read.description, /码点/)
  assert.match(read.description, /next_refs_cursor/)
  assert.match(read.description, /一跳/)
  assert.match(read.description, /命令面 \/memory-lab read/)
})


test('M7 单条注册失败后可补齐：保留已成功工具、不产生重复、最终三件齐全', () => {
  const engine = { noteOwnToolCall() {} }
  const registered = []
  let failName = MEMORY_CONTEXT_TOOL_LIST[1]
  const service = {
    register(definition) {
      if (definition.name === failName) throw new Error('boom')
      registered.push(definition.name)
      return () => {}
    },
  }
  const ctx = { get(name) { return name === 'tools' ? service : undefined }, logger: { warn() {} } }
  registerMemoryContextTools(ctx, { engine })
  const partial = memoryContextToolsRegistration(ctx)
  assert.equal(partial.phase, 'failed')
  assert.equal(partial.reason, 'register-incomplete')
  assert.equal(partial.registered, 2)
  assert.deepEqual(partial.names, MEMORY_CONTEXT_TOOL_LIST.filter((name) => name !== failName))

  // 失败原因消失后，再次调用注册入口应只补缺失的那一件。
  failName = null
  registerMemoryContextTools(ctx, { engine })
  const done = memoryContextToolsRegistration(ctx)
  assert.equal(done.phase, 'registered')
  assert.equal(done.registered, 3)
  assert.deepEqual([...registered].sort(), [...MEMORY_CONTEXT_TOOL_LIST].sort())
  assert.equal(registered.length, 3, '不得重复注册同一工具')
})
