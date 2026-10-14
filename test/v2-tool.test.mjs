/**
 * v2 只读召回工具测试。
 *
 * 边界（用户确认过的契约）：固定注册、只读、只读本会话 v2 隔离库、
 * 不重定向正式 lingshu_cg、不随 on/off 增删 schema、不隐藏任何原工具。
 * 本套件验证定义契约、schema 合法性（宿主支持子集）、只读性与预算报告。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { ensureLabRoot } from '../src/storage.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import {
  createV2RecallTool,
  V2_RECALL_TOOL_NAME,
  V2_RECALL_TOOL_PARAMETERS,
  V2_RECALL_TOOL_OUTPUT_SCHEMA,
  renderToolOutput,
  toToolValue,
} from '../src/v2/tool.mjs'

const SESSION_ID = 'tool0000000000000000abcd'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2tool-${name}-`))
  await ensureLabRoot(root)
  return root
}

function fakeAgent(sessionId = SESSION_ID) {
  const listeners = new Map()
  return {
    session: {
      id: sessionId,
      surface: { nodes: [], replaceGeneration: 0 },
      events: { on() {}, off() {} },
      on(type, handler) {
        const list = listeners.get(type) ?? []
        list.push(handler)
        listeners.set(type, list)
        return () => {}
      },
    },
    on() { return () => {} },
  }
}

async function seedRecords(root, count) {
  // 库由 enable 建立；这里只打开既有库（open 对未初始化会话返回 null）。
  const store = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID })
  try {
    const txn = await store.openTransaction()
    const ids = []
    for (let index = 0; index < count; index += 1) {
      const callId = `call-${index}`
      const call = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_CALL,
        seq: index * 2 + 1,
        inline: { range: `${index * 2 + 1}-${index * 2 + 2}` },
        refs: { callId, messageId: `msg-call-${index}`, toolName: 'read', blockIndex: 0 },
        content: `{"file":"alpha-${index}.txt"}`,
      }))
      ids.push(call.id)
      const result = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: index * 2 + 2,
        inline: { range: `${index * 2 + 1}-${index * 2 + 2}` },
        refs: { callId, resultMessageId: `msg-res-${index}` },
        content: `内容 ${index}：${'y'.repeat(200)}`,
      }))
      ids.push(result.id)
    }
    await store.commitTransaction(txn)
    return ids
  } finally {
    store.close()
  }
}

/** 校验 schema 只用宿主支持的子集关键字（type/oneOf/properties/required/additionalProperties/items/enum/const + annotations）。 */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/**
 * 宿主允许的 type 取值。
 *
 * 这条断言存在的理由：曾经用过 `type: 'json'` 表示可空字段，关键字检查放过了它，
 * 但宿主 `assertSupportedJsonSchema` 会因这个取值把**整份 schema** 拒绝，
 * 工具静默注册不上。用宿主真实校验器（`@deepseek-ai/dsh-tools`）实测确认后，
 * 这里把取值集合钉死，可空字段一律 `oneOf: [{type:'T'}, {type:'null'}]`。
 */
const SUPPORTED_TYPE_VALUES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function collectSchemaViolations(node, at = 'schema', out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${at} must be a schema object`)
    return out
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) out.push(`${at}.${key} 不在宿主支持子集内`)
  }
  if (Object.hasOwn(node, 'type') && !SUPPORTED_TYPE_VALUES.has(node.type)) {
    out.push(`${at}.type 取值 ${JSON.stringify(node.type)} 不被宿主接受`)
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    out.push(`${at}.additionalProperties 必须是布尔`)
  }
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) collectSchemaViolations(child, `${at}.properties.${key}`, out)
  }
  if (node.items) collectSchemaViolations(node.items, `${at}.items`, out)
  if (node.oneOf) node.oneOf.forEach((child, index) => collectSchemaViolations(child, `${at}.oneOf[${index}]`, out))
  return out
}

test('工具契约：固定名字、只读参数、schema 只用宿主支持子集', () => {
  const tool = createV2RecallTool({ runtime: { recall: async () => ({}) }, sessionIdOf: () => SESSION_ID })
  assert.equal(tool.name, V2_RECALL_TOOL_NAME)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(collectSchemaViolations(V2_RECALL_TOOL_PARAMETERS), [])
  assert.deepEqual(collectSchemaViolations(V2_RECALL_TOOL_OUTPUT_SCHEMA), [])
  // 参数关死未知键：宿主据此在调用前拒掉拼错的参数（探针实测：不声明就放行）。
  assert.equal(V2_RECALL_TOOL_PARAMETERS.additionalProperties, false)
  // 可空字段必须是 oneOf+null，不能是 nullable / type:'json' 这类宿主不认的写法。
  assert.deepEqual(V2_RECALL_TOOL_OUTPUT_SCHEMA.properties.matched_by, { oneOf: [{ type: 'string' }, { type: 'null' }] })
  // 参数只有读取语义：没有写入/执行字段。`cursor` 是预算用尽后继续读同一批结果的
  // 只读游标（规范 §6.3「预算用尽返回 partial + cursor」），不是新的检索能力。
  const keys = Object.keys(V2_RECALL_TOOL_PARAMETERS.properties).sort()
  assert.deepEqual(keys, ['budget_tokens', 'cursor', 'query', 'record_ids'])
  // 描述里必须写明「当时原文」而非新授权/新观察。
  assert.match(tool.description, /当时/)
})

test('工具未启用时如实返回未启用，不抛异常、不触碰冷库', async () => {
  const root = await makeLabRoot('disabled')
  try {
    const runtime = createV2Runtime({ labRoot: root, services: new Map(), logger: null, sessionIdOf: (session) => session.id })
    const tool = createV2RecallTool({ runtime, sessionIdOf: () => SESSION_ID })
    const value = await tool.execute({ query: 'alpha' }, { agent: fakeAgent() })
    assert.equal(value.engine_enabled, false)
    const text = renderToolOutput(SESSION_ID, value)
    assert.match(text, /未启用/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具启用后按 ID 精确回读原文，并按预算报告用量', async () => {
  const root = await makeLabRoot('read')
  try {
    const runtime = createV2Runtime({ labRoot: root, services: new Map(), logger: null, sessionIdOf: (session) => session.id })
    const agent = fakeAgent()
    await runtime.enable({ agent })
    try {
      // 库由 enable 建立；落库必须在 enable 之后（与真实降温顺序一致）。
      const ids = await seedRecords(root, 3)
      const tool = createV2RecallTool({ runtime, sessionIdOf: () => SESSION_ID })
      const value = await tool.execute({ record_ids: [ids[1]] }, { agent })
      assert.equal(value.engine_enabled, true)
      assert.equal(value.mode, 'ids')
      assert.equal(value.records.length, 1)
      assert.match(value.records[0].text, /内容 0/)
      assert.ok(value.used_tokens > 0)
      const text = renderToolOutput(SESSION_ID, value)
      assert.match(text, /当时记录的原文/)
    } finally {
      await runtime.disable({ agent })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具的字面检索只搜索引元数据，命中只给索引、正文仍要按 ID 回读', async () => {
  const root = await makeLabRoot('query')
  try {
    const runtime = createV2Runtime({ labRoot: root, services: new Map(), logger: null, sessionIdOf: (session) => session.id })
    const agent = fakeAgent()
    await runtime.enable({ agent })
    try {
      const ids = await seedRecords(root, 2)
      const tool = createV2RecallTool({ runtime, sessionIdOf: () => SESSION_ID })
      // 元数据命中：callId 在 refs 里。
      const value = await tool.execute({ query: 'call-1' }, { agent })
      assert.equal(value.mode, 'query')
      assert.ok(value.records.length >= 1)
      assert.ok(value.records.some((record) => record.id === ids[2]))
      // 检索命中只报索引，不附正文——避免把检索分数当置信度、把命中当事实。
      // has_payload 只说明「有载荷可回读」，正文本身一律不带。
      assert.equal(value.records.every((record) => record.text === null), true)
      assert.match(renderToolOutput(SESSION_ID, value), /不等于不存在/)

      // 载荷正文里的词不在索引里：搜不到是如实边界，不是「不存在」。
      const payloadOnly = await tool.execute({ query: 'yyyyyyyy' }, { agent })
      assert.equal(payloadOnly.records.length, 0)
      assert.match(renderToolOutput(SESSION_ID, payloadOnly), /不含载荷正文/)
    } finally {
      await runtime.disable({ agent })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具输出值可序列化，且不泄露本会话之外的路径', async () => {
  const root = await makeLabRoot('shape')
  try {
    const runtime = createV2Runtime({ labRoot: root, services: new Map(), logger: null, sessionIdOf: (session) => session.id })
    const agent = fakeAgent()
    await runtime.enable({ agent })
    try {
      const ids = await seedRecords(root, 1)
      const tool = createV2RecallTool({ runtime, sessionIdOf: () => SESSION_ID })
      const value = await tool.execute({ record_ids: ids }, { agent })
      const json = JSON.stringify(value)
      assert.ok(json.length > 0)
      assert.equal(json.includes(root), false, '输出不得包含隔离根路径')
      const blocks = tool.output.render({}, value)
      assert.equal(blocks[0].type, 'text')
      assert.ok(blocks[0].text.length > 0)
      // toToolValue 是纯投影：不含运行时内部对象。
      const projected = toToolValue(SESSION_ID, value)
      assert.equal(typeof projected, 'object')
    } finally {
      await runtime.disable({ agent })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
