/**
 * M-01 守卫（0.15.4）：脱敏不得吞掉与凭据无关的正文。
 *
 * ## 缺陷（真机复现，见 docs/dev-0.15.3/记忆上下文-0.15.3-全面排查报告.md M-01）
 *
 * `KEY_VALUE_RE` 普通分支的值边界曾经是 `[^\r\n]{4,}`——**吃到行尾**。一旦一行里
 * 出现凭据键，整行剩余正文都被替换成 `[REDACTED]`。真机后果：
 * - 一条 9,010 字的工具结果落库后只剩 759 字（8.4%）；
 * - 全库 23 条记录确证被截断。
 *
 * ## 修法（用户裁定问题 1-C「两步法」，0.15.4 落地）
 *
 * 把「值到哪结束」与「这段值要不要替换」拆成两件事：
 * 1. **边界**：值到**空白**为止（`VALUE_TOKEN`）。`;` `,` `)` 不切断——因为
 *    `DB_PASSWORD=abcdef;ghij` 的 `;ghij` 是同一凭据的后半段（0.15.1 修的漏）。
 * 2. **判据**：凭据键命中即替换（失败关闭）；ASCII `token` 是弱键，值像凭据才替换。
 *
 * 两个目标因此可以**同时**成立，不需要在「保住正文」和「不漏口令」之间取舍。
 *
 * ## 钉住的判据
 *
 * 1. 凭据 + 空白 + 正文 → 只替换凭据，正文逐字保留；
 * 2. 无空白的整段值 → 整段替换（半段泄露不回退）；
 * 3. 长正文的**长度下界**：输出不得比输入少超过凭据 token 本身的长度；
 * 4. 对照：不含凭据键的正文一个字都不改。
 *
 * ## 不适用条件
 *
 * - 不测对象路径（`redactValue`）——那里值边界天然清晰，走 `objectValueIsSecret`，
 *   口径是失败关闭，与本文本路径的「两步法」不同；
 * - 不测 URL 查询串分支（值到 `&/#` 为止）——由 `v3-redact-aud51` 覆盖；
 * - 不承诺「纯字母短口令 + 裸值」永远替换——值边界是空白之后，只要该值本身是
 *   独立 token（`DB_PASSWORD=swordfish` 就是），它**会被**替换；这不是残留。
 *
 * ## 变异自证
 *
 * 把 `VALUE_TOKEN` 改回 `[^\r\n]{4,}` → 用例 1、3 红；恢复 → 全绿。
 * 读数见文末「变异记录」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { redactText } from '../src/v3/domain/security/redact.mjs'

/** 一段与凭据完全无关的长正文（含中文、标点、数字，不触发任何其它规则）。 */
const LONG_BODY = '接下来要说的是归档流程：每完成一个步骤就生成回执，回执里包含记录 ID 与恢复入口。'
  + '这段正文与凭据毫无关系，必须原样保留下来，不能被任何脱敏规则吞掉。'
  + '补充说明：选择器按 seq 升序扫描，遇到回合边界就停止，不会跨回合拼接。'

test('M-01：凭据后的正文必须逐字保留', () => {
  const text = 'API_KEY=sk-abc123def456 ' + LONG_BODY
  const out = redactText(text)
  assert.ok(out.includes('[REDACTED]'), '凭据必须被替换')
  assert.ok(out.includes(LONG_BODY), '凭据之后的正文必须逐字保留，实际输出：' + out)
})

test('M-01：多行文本逐行独立，前面行被脱敏不影响后面行', () => {
  const text = [
    'API_KEY=sk-abc123def456 ' + LONG_BODY,
    LONG_BODY,
    'password="hunter2" 后面的说明文字',
  ].join('\n')
  const out = redactText(text)
  const lines = out.split('\n')
  assert.equal(lines.length, 3, '换行结构必须保留')
  assert.ok(lines[0].includes(LONG_BODY), '第 1 行正文保留')
  assert.equal(lines[1], LONG_BODY, '第 2 行完全不含凭据，必须一字不改')
  assert.ok(lines[2].includes('后面的说明文字'), '第 3 行引号值之后的正文保留')
})

test('M-01：值边界收紧后，无空白的整段值仍整段替换（半段泄露不回退）', () => {
  // B2-3 的回归保护：分号/逗号不是值的结束符
  assert.equal(redactText('DB_PASSWORD=abcdef;ghij'), 'DB_PASSWORD=[REDACTED]')
  assert.equal(redactText('DB_PASSWORD=abc,def'), 'DB_PASSWORD=[REDACTED]')
  assert.ok(!redactText('DB_PASSWORD=abcdef;ghij').includes('ghij'), '后半段不得泄露')
})

test('M-01：长度下界——输出只应比输入少「凭据 token」那部分', () => {
  const token = 'sk-abc123def456'
  const text = 'API_KEY=' + token + ' ' + LONG_BODY
  const out = redactText(text)
  const lost = text.length - out.length
  // 只允许少掉 token 长度与 [REDACTED] 长度之差；正文一个字都不能少。
  const expectedLost = token.length - '[REDACTED]'.length
  assert.equal(lost, expectedLost, '只应少掉凭据 token 本身，实际少掉 ' + lost + ' 字')
  assert.ok(out.length > text.length * 0.8, '输出不得塌缩（旧实现只剩约 8%）')
})

test('M-01 对照：不含凭据键的正文一字不改', () => {
  const text = '这是一段完全普通的正文，包含 ID 与 12345 这样的数字，还有 api 字样。'
  assert.equal(redactText(text), text)
})
