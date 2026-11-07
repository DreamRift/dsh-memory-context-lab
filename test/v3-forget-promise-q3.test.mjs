/**
 * 问题 3 守卫（0.15.4，用户裁定 B「改承诺」）：purge 的文案必须与账本实际行为一致。
 *
 * ## 缺陷背景
 *
 * 旧文案说「冷库正文与派生物已删除，不可撤销」。事实是：
 * - `records/*.json` 确实被删掉（正文真的没了）；
 * - 但 `vouchers.jsonl` 里该批凭证的 `receiptText`（约 400 字）与 `summaryText`
 *   （约 220 字）**仍然保留**——它们是审计账本的不可变组成部分（0.15.0 计划 §9.1
 *   「不改写历史 voucher」）。
 *
 * 真机核对（session-f7bc85e1，2026-11-06）：12/12 张凭证都留有这两种文本。
 * 于是「已删除」是过度承诺：用户可能以为字面全清，实际账本里还有数百字留痕。
 *
 * ## 用户裁定（问题 3）
 *
 * **B. 改承诺**——不改成真删账本（那会破坏可审计性），而是把话说准：
 * 「可见面已清除、检索不到、不可 undo」+「审计账本里仍留有回执与摘要的痕」。
 *
 * ## 本守卫钉住的判据
 *
 * 1. purge 成功文案**必须同时**包含：
 *    - 正文已删 / 不可读的正面陈述；
 *    - 账本仍留痕的**明示**（不得只说「已删除」了事）；
 *    - 「不可 undo / 不可恢复」的边界。
 * 2. 文案**不得**再出现旧的无条件承诺（「派生物已删除」这种把账本也算进去的说法）。
 * 3. forget（非 purge）的文案仍保留「需要不可恢复请用 forget purge」的分流提示。
 *
 * ## 不适用条件
 *
 * - 本守卫只钉**文案**，不验证 purge 的删除实现（那是 `v3-forget*` 的职责）；
 * - 不覆盖文件系统层面的证据消除——插件本来就不能删 DSH append-only 会话日志
 *   （见 AGENTS.md「隔离边界」），这一点在文案里也不承诺。
 *
 * ## 变异自证
 *
 * 把文案改回旧的「冷库正文与派生物已删除，不可撤销」→ 用例 1、2 红；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.join(here, '..', 'src', 'index.mjs')
const source = readFileSync(indexPath, 'utf8')

/** 取出 `op === 'purge'` 那一支的文案表达式（到 `: '已遗忘` 为止）。 */
function purgeBranch() {
  const i = source.indexOf("? '已物理清除 '")
  assert.ok(i >= 0, '必须能找到 purge 的文案分支')
  const j = source.indexOf(": '已遗忘 '", i)
  assert.ok(j > i, '必须能找到 forget（非 purge）分支作为结束标记')
  return source.slice(i, j)
}

test('问题 3-B：purge 文案必须明示「账本仍留痕」，不能只说已删除', () => {
  const branch = purgeBranch()
  assert.ok(/审计账本/.test(branch), '文案必须提到审计账本留痕，实际：' + branch)
  assert.ok(/(回执|摘要)/.test(branch), '文案必须明示留下的是回执/摘要')
})

test('问题 3-B：不得再出现旧的无条件承诺', () => {
  // 只看**代码里的字符串字面量**，不看注释——注释里保留旧文案作为历史说明是允许的
  // （否则守卫会把「记录缺陷」的注释本身判红，这是守卫自己的误伤）。
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.ok(
    !/冷库正文与派生物已删除/.test(code),
    '旧的「派生物已删除」承诺必须已被替换（代码字面量里不得再出现）',
  )
})

test('问题 3-B：purge 文案仍须给出「不可撤销」边界', () => {
  const branch = purgeBranch()
  assert.ok(/(不可撤销|不可 undo|不可恢复)/.test(branch), '必须保留不可撤销的边界，实际：' + branch)
})

test('问题 3-B：forget 与 purge 的分流提示保留', () => {
  assert.ok(/需要不可恢复请用 forget purge/.test(source), 'forget 文案应继续把「不可恢复」导向 purge')
})
