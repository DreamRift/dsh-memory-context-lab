/**
 * S1 assistant-claim 保留红例先行套件（0.10.1 第二批，方案 §7）。
 *
 * 铁律（方案原文）：
 * - 「确定性规则抽出一句」只证明抽到了原话，不证明内容正确——claim 默认
 *   unverified，hash 校验通过不是事实验证，exit 0 也不能直接推出任务完成。
 * - 反例不可被关键词升级为「已完成」：否定（尚未/没有/未通过）、条件（如果/
 *   待确认）、引用（用户说/据报告/文档称）、撤回（更正：/撤回先前）。
 * - claim 保存原句 + sourceRef，不保存改写；一行一个 claim，行内去格式噪声。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractClaims, CLAIM_POLARITIES, isClaimLine,
} from '../src/v2/claims.mjs'

// ---- isClaimLine：一行是不是结论性陈述 ---------------------------------------

test('S1-C1 结论行判定：肯定完成句是 claim 行，默认 unverified', () => {
  assert.equal(isClaimLine('已完成：检索契约修复全部落地，608 项 0 失败。'), true)
  assert.equal(isClaimLine('S2 回读闭环实现完成。'), true)
  // 非结论行：疑问、祈使、纯标题、代码块行。
  assert.equal(isClaimLine('这个怎么做？'), false)
  assert.equal(isClaimLine('请继续。'), false)
  assert.equal(isClaimLine('## 标题'), false)
  assert.equal(isClaimLine('    const x = 1'), false)
})

test('S1-C2 反例不升级：否定/条件/引用/撤回句各自携带极性与限定，不被当「已完成」', () => {
  const negative = extractClaims('测试尚未通过，仍需修复。')
  assert.equal(negative.length, 1)
  assert.equal(negative[0].polarity, CLAIM_POLARITIES.NEGATED)
  assert.equal(negative[0].verified, false)

  const conditional = extractClaims('如果完成迁移，就能升版本。')
  assert.equal(conditional.length, 1)
  assert.equal(conditional[0].polarity, CLAIM_POLARITIES.CONDITIONAL)
  assert.equal(conditional[0].verified, false)

  const cited = extractClaims('用户说该模块已经修完了。')
  assert.equal(cited.length, 1)
  assert.equal(cited[0].polarity, CLAIM_POLARITIES.CITED)
  assert.equal(cited[0].verified, false)

  const retracted = extractClaims('更正：先前「全部通过」的结论不成立。')
  assert.equal(retracted.length, 1)
  assert.equal(retracted[0].polarity, CLAIM_POLARITIES.RETRACTED)
  assert.equal(retracted[0].verified, false)
})

// ---- extractClaims：整段提取 --------------------------------------------------

test('S1-C3 提取保持原句：claim.value 是原行文本，不改写、不摘要', () => {
  const text = [
    '先看了下代码。',
    '已完成：S3 折叠实现，625 项全绿。',
    '接下来做 S1。',
  ].join('\n')
  const claims = extractClaims(text)
  assert.equal(claims.length, 1, '只提取结论行，非结论行不进')
  assert.ok(claims[0].value.includes('S3 折叠实现'), '保留原句内容')
  assert.equal(claims[0].verified, false, '默认 unverified')
  assert.ok(typeof claims[0].lineNumber === 'number')
})

test('S1-C4 混合反例段：多行多 claim，极性逐行正确', () => {
  const text = [
    '已完成：检索修复。',
    '但尚未通过复审。',
    '如果复审通过，就提交。',
  ].join('\n')
  const claims = extractClaims(text)
  assert.equal(claims.length, 3)
  assert.equal(claims[0].polarity, CLAIM_POLARITIES.POSITIVE)
  assert.equal(claims[1].polarity, CLAIM_POLARITIES.NEGATED)
  assert.equal(claims[2].polarity, CLAIM_POLARITIES.CONDITIONAL)
  // 全部默认 unverified，包括 POSITIVE。
  for (const claim of claims) assert.equal(claim.verified, false)
})

test('S1-C5 代码块/引用块不提取：围栏与引用行不是 assistant 结论', () => {
  const text = [
    '已完成：接线。',
    '```',
    '已完成：伪装的代码块行。',
    '```',
    '> 已完成：引用别人的话。',
  ].join('\n')
  const claims = extractClaims(text)
  assert.equal(claims.length, 1, '只有正文行参与提取')
  assert.ok(claims[0].value.includes('接线'))
})

test('S1-C6 空输入与非字符串输入：空数组、不抛错', () => {
  assert.deepEqual(extractClaims(''), [])
  assert.deepEqual(extractClaims(null), [])
  assert.deepEqual(extractClaims(undefined), [])
  assert.deepEqual(extractClaims(42), [])
})

test('S1-C8 标定补例：全绿/0 失败 完成句提取；「没有证据」否定句提取', () => {
  // 标定抽检（review-s3/calibration-samples.md 第 19/20 行）发现的漏报：
  // 完成句的常用变体（全绿、0 失败）与否定结论（没有证据表明）必须覆盖。
  const done = extractClaims('608 项全绿，0 失败（2026-10-17 实测）。')
  assert.equal(done.length, 1)
  assert.equal(done[0].polarity, CLAIM_POLARITIES.POSITIVE)

  const noEvidence = extractClaims('没有证据表明宿主提供确认回调 seam。')
  assert.equal(noEvidence.length, 1)
  assert.equal(noEvidence[0].polarity, CLAIM_POLARITIES.NEGATED, '否定结论不得漏报')
})

test('S1-C7 提取上限有界：长正文按行数上限截断并如实报告', () => {
  const lines = []
  for (let i = 0; i < 300; i += 1) lines.push('已完成：第 ' + i + ' 项工作。')
  const claims = extractClaims(lines.join('\n'), { maxLines: 200 })
  assert.ok(claims.length <= 200, '提取行数有上限，实际 ' + claims.length)
})
