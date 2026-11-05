/**
 * P1-01（0.15.1）：中文键名的文本脱敏缺口（= 报告 §1★1 / PR #11 问题 2）。
 *
 * ## 缺陷
 * 文本规则（KEY_VALUE_RE / QUOTED_KEY_VALUE_RE）的键名真源是 ASCII 字符类
 * `[A-Za-z0-9_.-]`，对象面 `isSensitiveKey` 却认「密码/密钥/令牌/凭据/凭证」。
 * 于是 `密码：abc123`、`密钥=abc123`、`{"密码": "abc123"}` 原样通过，而
 * `password：abc123` 正常脱敏。`tool/result` 是不经对象面的摄入路径（env / curl /
 * 配置文件 / 日志），换言之：**带中文标签的凭据明文入库**；`export` 走同一个
 * `redactText`（domain/export/bundle.mjs），分享包同样带明文。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★1 / §3.1 P1-01；
 * 用户裁定（2026-11-04）：「脱敏口径按 PR #11 方案——中文键后一律替换」。
 *
 * ## 修法（根因，不是补丁）
 * - 键名真源只留一份：`SECRET_KEY_CJK` 同时喂给对象面 `SENSITIVE_KEY` 与文本面键体；
 * - 文本面键体改为「ASCII 键体 | 中文键体」，中文键体允许至多 8 个 ASCII/CJK 前缀
 *   （数据库密码 / 登录口令 / API密钥），不允许中文后缀（`密码学：…` 不误伤）；
 * - 起点边界从 `\b` 换成 `(?<![A-Za-z0-9_])`：JS 的 \w 只有 ASCII，`\b` 在 CJK 起首处
 *   不成立，这也是旧规则对中文键整条失效的第二重原因；
 * - `textValueIsSecret`：中文凭据键命中即无条件替换（`令牌：abc` 这种纯字母值也替换），
 *   ASCII 的 token 键仍保留 B3-3 的形态放宽（`token: oauth` 不误伤）。
 *
 * ## 断言组
 * 1. 文本面：中文键（裸键 / 引号键 / 全角冒号 / URL 编码分隔符 / URL 查询串 / 中文前缀）全部替换；
 * 2. 值边界：URL 查询串的下一个参数不被误吞（`&page=2` 保留）；
 * 3. 防误伤：`密码学：…`、`密钥长度：…`、`author`、`the token: appears` 保持原文；
 * 4. 摄入面：隔离根记录字节不含中文明文（量具自检：记录里确有该键）；
 * 5. 导出面：`buildExportBundle` 分享包字节不含中文明文。
 *
 * ## 不适用条件与已知边界
 * - 中文键的**值边界**沿用既有「到行尾」口径：`密码：abc，然后继续` 会把逗号后的正文一并
 *   替换（宁可多脱敏不可漏，与 ASCII 键一致，不引入第二套口径）；
 * - 中文**后缀**键（`密码字段：…`）不识别：为保住 `密码学/密钥长度` 这类技术名词；
 *   真实凭据通常另有 ASCII 形态或走对象面；
 * - user / assistant 正文摄入仍不脱敏（beta.48 产品口径），导出侧再兜底。
 *
 * ## 定点变异自证
 * 把 `SECRET_KEY_CJK_BODY` 从 `SECRET_KEY_BODY` 的交替里去掉（即回到纯 ASCII 键体）→
 * 「文本面中文键」与「摄入/导出面」用例必红；把 `KEY_BOUNDARY` 换回 `\\b` → 中文键
 * 用例同样必红（第二重根因的独立证据）。两次读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { redactText, redactValue, isSensitiveKey } from '../src/v3/domain/security/redact.mjs'
import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
import { attachV3Engine, extractEventBody } from '../src/v3/entry/v3-entry.mjs'

/** 审计样本：中文键 × 路径形态（明文值都要消失）。 */
const CJK_SAMPLES = [
  ['密码：abc123', 'abc123'],
  ['密钥=abc123', 'abc123'],
  ['数据库密码：P@ssw0rd9', 'P@ssw0rd9'],
  ['登录口令: hunter2', 'hunter2'],
  ['访问凭据：credExtra99', 'credExtra99'],
  ['{"密码": "zhongwenMIMA999"}', 'zhongwenMIMA999'],
  ["{'密钥': 'quoteSecret77'}", 'quoteSecret77'],
  ['密码%3DurlEncodedPass1', 'urlEncodedPass1'],
  ['https://example.test/x?密码=querySecret42&page=2', 'querySecret42'],
]

test('P1-01 文本面：中文键（裸键/引号键/全角冒号/URL 形态）必须脱敏', () => {
  for (const [text, secret] of CJK_SAMPLES) {
    const out = redactText(text)
    assert.ok(!out.includes(secret), '不得保留明文：' + text + ' → ' + out)
    assert.ok(out.includes('[REDACTED]'), '必须出现脱敏标记：' + text + ' → ' + out)
  }
})

test('P1-01 文本面：引号键替换后 JSON 仍可解析（保留外壳）', () => {
  const out = redactText('{"密码": "abc123"}')
  assert.deepEqual(JSON.parse(out), { 密码: '[REDACTED]' })
  assert.deepEqual(JSON.parse(redactText('{"apiKey":"abc123"}')), { apiKey: '[REDACTED]' })
})

test('P1-01 值边界：URL 查询串的下一个参数不被误吞', () => {
  const out = redactText('https://example.test/x?密码=querySecret42&page=2')
  assert.ok(out.includes('page=2'), '下一个参数不得被吞：' + out)
  assert.ok(!out.includes('querySecret42'), '查询串值必须替换：' + out)
})

test('P1-01 防误伤：技术名词与既有白名单保持原文', () => {
  assert.equal(redactText('密码学：对称加密算法'), '密码学：对称加密算法')
  assert.equal(redactText('密钥长度：256 位'), '密钥长度：256 位')
  assert.equal(redactText('author: 张三'), 'author: 张三')
  assert.equal(redactText('the token: appears'), 'the token: appears')
  assert.equal(redactText('token: oauth'), 'token: oauth')
  // 中文键不做形态放宽：纯字母口令同样是凭据
  assert.equal(redactText('令牌：myword'), '令牌：[REDACTED]')
})

test('P1-01 对象面与文本面同源：中文凭据键两边都认', () => {
  assert.equal(isSensitiveKey('密码'), true)
  assert.equal(isSensitiveKey('口令'), true)
  assert.deepEqual(redactValue({ 密码: 'abc123', author: '张三' }), { 密码: '[REDACTED]', author: '张三' })
})

test('P1-01 摄入面：tool/result 中文凭据不进冷库明文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p101-redact-'))
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = {
      id: 's-p101',
      log: [],
      events() { return this.log },
      surface: { nodes: [] },
      append(type, data) { const seq = this.log.length; this.log.push({ seq, type, at: seq, data: data ?? {} }); return { seq } },
      eventAt(seq) { return this.log.find((event) => event.seq === seq) },
      deriveMessages() { return [] },
      pushUser(text) { return this.append('user/message', { message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: 'user' } }) },
    }
    const lines = CJK_SAMPLES.map(([text]) => text).join('\n')
    session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: lines }] } })
    session.pushUser('继续')
    await ctx.callPreStep(session)
    await engine._waitForIdle()

    const files = (await readdir(root, { recursive: true, type: 'file' })).filter((name) => name.endsWith('.json'))
    assert.ok(files.length > 0, '量具自检：隔离根里必须有记录文件')
    let sawKey = false
    for (const file of files) {
      const bytes = await readFile(path.join(root, file))
      if (bytes.includes('密码')) sawKey = true
      for (const [, secret] of CJK_SAMPLES) {
        assert.ok(!bytes.includes(secret), '记录字节不得含明文 ' + secret + '：' + file)
      }
    }
    assert.equal(sawKey, true, '量具自检：记录里确实有该键（否则上面的断言没有证据力）')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-01 导出面：分享包字节不含中文明文', () => {
  const text = CJK_SAMPLES.map(([line]) => line).join('\n')
  const bundle = buildExportBundle({
    sessionKey: 's-p101-export',
    records: [{
      id: 'v3r-bbbbbbbbbbbbbbbb',
      kind: 'message-assistant',
      createdAt: 1,
      payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
      provenance: { sourceEventId: null, sourceForm: null, transactionId: null },
    }],
  })
  const bytes = Buffer.from(JSON.stringify(bundle), 'utf8')
  for (const [, secret] of CJK_SAMPLES) assert.ok(!bytes.includes(secret), '导出包不得含明文：' + secret)
  assert.equal(bundle.exportPolicy, 'redacted')
  assert.ok(bundle.records[0].payload.text.includes('[REDACTED]'))
})

test('P1-01 量具自检：样本里的明文确实出现在原始文本且摄入正文被替换', () => {
  for (const [line, secret] of CJK_SAMPLES) {
    assert.ok(line.includes(secret), '样本自检：' + line)
    const body = extractEventBody({ type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: line }] } } })
    assert.ok(body.text.includes('[REDACTED]'), '摄入正文必须被替换：' + line)
  }
})
