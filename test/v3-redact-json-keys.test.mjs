/**
 * v3 摄入脱敏守卫（AUD50-02-01，B1-1：JSON 引号键凭据绕过脱敏）。
 *
 * ## 缺陷
 * SENSITIVE_VALUE_PATTERNS 的键值规则要求键名后**直接**是分隔符（:/=），JSON 形态的
 * 键名后先有结束引号（"api_key":），规则不匹配；值字符类也不含两侧引号。于是
 * tool/result 正文里 6 种 JSON 引号键凭据形态原样入库（审计探针 probe-json-redact.mjs
 * 实证），导出分享包同样带明文（导出侧由 AUD50-07-01/B2-10 用同一函数再脱敏）。
 *
 * ## 判据来源
 * docs/dev-0.14.0/审计-0.14.0-beta.50-后续-20261029.md §5 AUD50-02-01；
 * 缺陷修复任务书 B1-1。修前探针实测 8 形态全泄露（.tmp/fix-B1-1/）。
 *
 * ## 断言组
 * - 6 种 JSON 引号键形态：输出不含明文、键名与其余字段保留、双引号形态 JSON 仍可解析；
 * - 嵌套 JSON（内层 api_key）同样脱敏；
 * - 非法 JSON（JSON 形态 + 尾随文本；裸键引号值 + 尾随文本）不漏；
 * - 端到端：tool/result 事件摄入后，隔离根记录字节不含明文（量具自检：记录确含该键）；
 * - 现状锚定：author/authMode 文本路径不脱敏（对象路径误伤由 B3-3 收紧，本批不扩面）。
 *
 * ## 不适用条件与已知边界
 * - assistant/user 正文摄入路径按产品口径不脱敏（beta.48 明确不做）；导出再脱敏见
 *   AUD50-07-01。
 * - ;/, 分隔符截断泄露由 AUD50-02-05（B2-3）单独处理，本文件不断言该形态。
 *
 * ## 定点变异自证
 * 临时回退 v3-entry.mjs 的引号键规则 → JSON 形态用例必红；恢复后全绿
 * （红/绿证据存 .tmp/fix-B1-1/）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine, extractEventBody } from '../src/v3/entry/v3-entry.mjs'

const SECRET = 'hunter2secretX'

/** 走 tool/result 正文通道（真实泄漏落点：工具输出是外部数据）。 */
function toolResult(text) {
  return extractEventBody({
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text }] } },
  })
}

test('B1-1 形态1：双引号键 + 冒号后空格（JSON.stringify 标准输出）', () => {
  const body = toolResult('{"api_key": "' + SECRET + '"}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  const parsed = JSON.parse(body.text)
  assert.equal(parsed.api_key, '[REDACTED]', '值被替换')
  assert.ok('api_key' in parsed, '键名保留')
})

test('B1-1 形态2：双引号键 + 冒号紧贴（无空白）', () => {
  const body = toolResult('{"api_key":"' + SECRET + '"}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.equal(JSON.parse(body.text).api_key, '[REDACTED]')
})

test('B1-1 形态3：单引号键 + 单引号值', () => {
  const body = toolResult("{'api_key': '" + SECRET + "'}")
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.ok(body.text.includes("'api_key'"), '键名与键引号保留：' + body.text)
  assert.ok(body.text.includes("'[REDACTED]'"), '值引号保留：' + body.text)
})

test('B1-1 形态4：前缀/后缀键 SecretAccessKey', () => {
  const body = toolResult('{"SecretAccessKey": "' + SECRET + '"}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.ok(body.text.includes('"SecretAccessKey"'), '键名保留：' + body.text)
})

test('B1-1 形态5：点分键 db.password', () => {
  const body = toolResult('{"db.password": "' + SECRET + '"}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.ok(body.text.includes('"db.password"'), '键名保留：' + body.text)
})

test('B1-1 形态6：双引号值内含 \" 转义引号', () => {
  const body = toolResult('{"api_key": "ab\\"' + SECRET + '"}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.equal(JSON.parse(body.text).api_key, '[REDACTED]', '值整体替换（含转义段）')
})

test('B1-1 嵌套 JSON：内层 api_key 也脱敏', () => {
  const body = toolResult('{"outer":{"api_key":"' + SECRET + '"}}')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.equal(JSON.parse(body.text).outer.api_key, '[REDACTED]', '内层值替换')
  assert.equal(JSON.parse(body.text).outer instanceof Object, true, '外层结构保留')
})

test('B1-1 其余字段保留：多字段 JSON 只替换凭据值', () => {
  const text = '{"user":"alice","api_key":"' + SECRET + '","role":"admin"}'
  const body = toolResult(text)
  const parsed = JSON.parse(body.text)
  assert.equal(parsed.user, 'alice', '非敏感字段保留')
  assert.equal(parsed.role, 'admin', '非敏感字段保留')
  assert.equal(parsed.api_key, '[REDACTED]', '凭据值替换')
})

test('B1-1 非法 JSON：JSON 形态 + 尾随文本也要脱敏', () => {
  const body = toolResult('{"api_key": "' + SECRET + '"} trailing')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.ok(body.text.includes('trailing'), '尾随文本保留：' + body.text)
})

test('B1-1 非法 JSON：tool/call 参数字符串（无法 JSON.parse）不漏', () => {
  const body = extractEventBody({
    type: 'tool/call',
    data: { callId: 'call_b11', name: 'run', arguments: '{"api_key": "' + SECRET + '"} trailing' },
  })
  assert.equal(typeof body.structure.arguments, 'string', '非法 JSON 保持字符串形态')
  assert.ok(!body.text.includes(SECRET), '正文不得含明文：' + body.text)
  assert.ok(!JSON.stringify(body.structure).includes(SECRET), 'structure 不得含明文')
})

test('B1-1 裸键 + 引号值 + 尾随文本（既有裸键规则锚定，不回退）', () => {
  const body = toolResult('api_key="' + SECRET + '" trailing')
  assert.ok(!body.text.includes(SECRET), '不得含明文：' + body.text)
  assert.ok(body.text.includes('trailing'), '尾随文本保留：' + body.text)
})

test('B1-1 现状锚定：author/authMode 文本路径不误伤（B3-3 再收紧）', () => {
  const body = toolResult('{"author":"张三","authMode":"oauth"}')
  assert.ok(body.text.includes('张三'), 'author 不被误伤：' + body.text)
  assert.ok(body.text.includes('oauth'), 'authMode 不被误伤：' + body.text)
})

// ---------- 端到端：事件 → 摄入 → 隔离根记录字节 ----------

function fakeSession(id) {
  let seq = 0
  const events = []
  const session = {
    id,
    log: events,
    events: () => events,
    surface: { nodes: [] },
    append(type, data) {
      seq += 1
      return { seq }
    },
    eventAt() { return null },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const s = events.length
      events.push({ seq: s, type, at: s, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
  return session
}

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    warnings: [],
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => ctx.warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: 'enter' }) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

test('B1-1 端到端：tool/result 摄入后隔离根记录字节不含明文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-b11-e2e-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = fakeSession('s1')
    const agent = { session }
    session.push('tool/result', {
      data: { message: { role: 'tool', content: [{ type: 'text', text: '{"api_key": "' + SECRET + '"}'}] } },
    })
    await ctx.callPreStep(agent)
    await engine._waitForIdle()

    const files = (await readdir(root, { recursive: true, type: 'file' })).filter((f) => f.endsWith('.json'))
    let sawKey = false
    for (const file of files) {
      const bytes = await readFile(path.join(root, file))
      if (bytes.includes('api_key')) sawKey = true
      assert.ok(!bytes.includes(SECRET), '记录字节不得含明文：' + file)
    }
    assert.ok(sawKey, '量具自检：至少一条记录含该键（否则本断言无证据力）')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
