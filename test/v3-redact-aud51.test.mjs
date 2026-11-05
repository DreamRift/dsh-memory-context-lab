/**
 * AUD51-07-01 / 07-02（0.14.0-beta.53）：纯字母凭据值 + Cookie/Session 文本形态的脱敏。
 *
 * ## 缺陷
 * 07-01：文本路径对**所有**凭据键都要求「值像凭据」（credentialShapedValue），
 * 于是纯字母值被放行——`DB_PASSWORD=swordfish`、`secret: MyVerySecretValue`、
 * `API_KEY=alphaBetaGamma` 原样入库并进导出包。
 * 07-02：`Cookie:` / `Set-Cookie:` / `session_id=` 三个键名根本不在文本规则的键词表里，
 * 整行完全不脱敏（`Cookie: a=1; b=2`、`Set-Cookie: sid=…; HttpOnly`）。
 *
 * ## 判据来源
 * docs/dev-0.14.0/审计-0.14.0-beta.51-后续-20261030.md §13 / §14；用户拍板（本轮 F3）。
 *
 * ## 修法
 * 文本路径与对象路径共用 `textValueIsSecret`：
 * - token / 令牌 键：仍按形态判（`token: oauth`、`the token: appears` 不误伤，B3-3 不回退）；
 * - 其余凭据键（password / secret / api_key / credential / cookie / session_id）：
 *   **无条件替换**，纯字母口令同样是凭据；
 * - 键词表加入 cookie / set-cookie / session_id（`SECRET_KEY_WORDS` 单一真源）。
 *
 * ## 断言组
 * - 文本路径：三个审计样本 + Cookie/Set-Cookie/session_id 全部替换；
 * - 摄入路径（tool/result → 记录正文）：隔离根记录字节不含明文（量具自检：记录里确有该键）；
 * - 导出路径（buildExportBundle）：分享包字节不含明文；
 * - 防误杀对照：`author` / `authMode` / `token: oauth` / `the token: appears` 保持原文。
 *
 * ## 不适用条件与已知边界
 * - `token` 键的普通词仍放行（`token: swordfish` 不会被脱敏）——B3-3 的收敛与「不误伤散文」
 *   是同一个取舍，本轮只按用户口径收紧 password/secret/api_key 类键，token 键不动。
 * - user / assistant 正文摄入仍不脱敏（beta.48 产品口径），导出侧再脱敏兜底。
 *
 * ## 定点变异自证
 * 把 textValueIsSecret 改回「所有键都走 credentialShapedValue」→ 07-01 三条必红；
 * 从 SECRET_KEY_WORDS 去掉 cookie/session → 07-02 三条必红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { redactText, redactValue } from '../src/v3/domain/security/redact.mjs'
import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
import { attachV3Engine, extractEventBody } from '../src/v3/entry/v3-entry.mjs'

/** 审计样本（07-01）：纯字母凭据值。 */
const ALPHA_SECRETS = [
  ['DB_PASSWORD=swordfish', 'swordfish'],
  ['secret: MyVerySecretValue', 'MyVerySecretValue'],
  ['API_KEY=alphaBetaGamma', 'alphaBetaGamma'],
]

/** 审计样本（07-02）：Cookie / Set-Cookie / session_id。 */
const COOKIE_SECRETS = [
  ['Cookie: a=1; b=2', 'a=1; b=2'],
  ['Set-Cookie: sid=deadbeefcafe; HttpOnly', 'deadbeefcafe'],
  ['session_id=abcdef123456', 'abcdef123456'],
]

test('AUD51-07-01 文本路径：纯字母凭据值必须脱敏', () => {
  for (const [text, secret] of ALPHA_SECRETS) {
    const out = redactText(text)
    assert.ok(!out.includes(secret), '不得保留明文：' + text + ' → ' + out)
    assert.ok(out.includes('[REDACTED]'), '必须出现脱敏标记：' + out)
  }
})

test('AUD51-07-02 文本路径：Cookie / Set-Cookie / session_id 必须脱敏', () => {
  for (const [text, secret] of COOKIE_SECRETS) {
    const out = redactText(text)
    assert.ok(!out.includes(secret), '不得保留明文：' + text + ' → ' + out)
  }
  // JSON 引号键与 URL 查询串两种形态同口径
  assert.ok(!redactText('{"session_id": "abcdef123456"}').includes('abcdef123456'))
  const url = redactText('https://example.test/x?session_id=abcdef123456&page=2')
  assert.ok(!url.includes('abcdef123456'), 'URL 查询串不得漏：' + url)
  assert.ok(url.includes('page=2'), '下一个参数不得被误吞：' + url)
})

test('防误杀对照：authMode / author / token 键的普通词保持原文', () => {
  assert.equal(redactText('author: 张三'), 'author: 张三')
  assert.equal(redactText('authMode: oauth'), 'authMode: oauth')
  assert.equal(redactText('the token: appears'), 'the token: appears')
  assert.equal(redactText('token: oauth'), 'token: oauth')
  assert.deepEqual(redactValue({ author: '张三', authMode: 'oauth', token: 'oauth' }), { author: '张三', authMode: 'oauth', token: 'oauth' })
})

test('AUD51-07-01/07-02 摄入路径：记录正文与结构都不含明文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-aud51-redact-'))
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
      id: 's-redact',
      log: [],
      events() { return this.log },
      surface: { nodes: [] },
      append(type, data) { const seq = this.log.length; this.log.push({ seq, type, at: seq, data: data ?? {} }); return { seq } },
      eventAt(seq) { return this.log.find((event) => event.seq === seq) },
      deriveMessages() { return [] },
      pushUser(text) { return this.append('user/message', { message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: 'user' } }) },
    }
    const lines = [...ALPHA_SECRETS, ...COOKIE_SECRETS].map(([text]) => text).join('\n')
    session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: lines }] } })
    session.pushUser('继续')
    await ctx.callPreStep(session)
    await engine._waitForIdle()

    const files = (await readdir(root, { recursive: true, type: 'file' })).filter((name) => name.endsWith('.json'))
    assert.ok(files.length > 0, '量具自检：隔离根里必须有记录文件')
    let sawKey = false
    for (const file of files) {
      const bytes = await readFile(path.join(root, file))
      if (bytes.includes('DB_PASSWORD')) sawKey = true
      for (const [, secret] of [...ALPHA_SECRETS, ...COOKIE_SECRETS]) {
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

test('AUD51-07-01/07-02 导出路径：分享包字节不含明文', () => {
  const text = [...ALPHA_SECRETS, ...COOKIE_SECRETS].map(([line]) => line).join('\n')
  const bundle = buildExportBundle({
    sessionKey: 's-export',
    records: [{
      id: 'v3r-aaaaaaaaaaaaaaaa',
      kind: 'message-assistant',
      createdAt: 1,
      payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
      provenance: { sourceEventId: null, sourceForm: null, transactionId: null },
    }],
  })
  const bytes = Buffer.from(JSON.stringify(bundle), 'utf8')
  for (const [, secret] of [...ALPHA_SECRETS, ...COOKIE_SECRETS]) {
    assert.ok(!bytes.includes(secret), '导出包不得含明文：' + secret)
  }
  assert.equal(bundle.exportPolicy, 'redacted')
  assert.ok(bundle.records[0].payload.text.includes('[REDACTED]'))
})

test('量具自检：文本路径没被短路（SAMPLES 里的每个密钥都真的会出现在原始文本里）', () => {
  for (const [line, secret] of [...ALPHA_SECRETS, ...COOKIE_SECRETS]) {
    assert.ok(line.includes(secret), '样本自检：' + line)
    assert.ok(extractEventBody({ type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: line }] } } }).text.includes('[REDACTED]'), '摄入正文必须被替换：' + line)
  }
})
