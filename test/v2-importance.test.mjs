/**
 * F1 单测：灵枢重要度驱动的软保留评分器（纯函数）。
 *
 * 覆盖开发要求 §2.5 的七条：
 * 1. novelty 反向校准：与当前请求高度重合的历史评高分、靠后丢；
 * 2. 插件自产卡片 source 权重低，但不因此进硬保护（评分器没有保护语义）；
 * 3. stale/unverified 证据 basis_trust 低分；
 * 4. 反复被回读的历史 hits 提级；
 * 5. 硬保护项不参与打分（评分器没有硬保护入口，也不输出保护语义）；
 * 6. 同分时确定性（同输入同输出，排序兜底交给接入侧的类目次序）；
 * 7. 打分是纯函数（不读写冷库、不碰宿主、无副作用）。
 *
 * 诚实边界测试：评分器不调模型、不写文件（模块零依赖，import 面只有自身）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  IMPORTANCE_WEIGHTS,
  SOURCE_WEIGHTS,
  BASIS_TRUST,
  BASIS_TRUST_UNSTATED,
  HITS_SATURATION,
  bigramsOf,
  stripTemplateSkeleton,
  relevanceOf,
  hitBoostOf,
  sourceBucketForRetentionItem,
  scoreSoftRetention,
  formatImportanceReason,
} from '../src/v2/importance.mjs'

const CONTEXT = {
  hardPrefixText: '当前人类请求：修复 client.js 的全历史开关。最小工作状态：client.js 的 switchNode 回调。',
  currentRequestText: '修复 client.js 全历史开关的 off 分支，先补兜底再回归测试。',
}

test('F1-1 novelty 反向校准：与当前请求高度重合的历史评高分（绝不照抄「越新越好」）', () => {
  const related = scoreSoftRetention({
    lines: ['非必要历史：client.js 的 fullhistory 开关 off 分支修复记录，switchNode 回调条件'],
    retentionClass: 'non-essential-history',
    source: 'surface:progress',
  }, CONTEXT)
  const unrelated = scoreSoftRetention({
    // 用与 CONTEXT 完全不相交的字符集构造「真正无重叠」的候选（字符级 bigram
    // 下常见词很容易撞上：连「分支」「当前」都会交集，这是刻意的零重叠对照）。
    lines: ['㊀㊁㊂㊃㊄㊅㊆㊇ ㊈㊊㊋㊌ ㊍㊎㊏㊐'],
    retentionClass: 'non-essential-history',
    source: 'surface:progress',
  }, CONTEXT)
  assert.ok(
    related.score > unrelated.score,
    `相关历史的分值必须更高（反向校准），got related=${related.score} unrelated=${unrelated.score}`,
  )
  assert.ok(related.components.relevance > 0, '相关历史的 relevance 必须大于 0')
  assert.equal(unrelated.components.relevance, 0, '无重叠的候选 relevance 必须如实为 0')
})

test('F1-2 插件自产卡片：source 权重低，但评分器没有「保护」语义——分值只决定丢弃顺序', () => {
  const pluginAuthored = scoreSoftRetention({
    lines: ['进度 p12 工具 read 状态 done'],
    source: 'surface:progress',
    retentionClass: 'non-essential-history',
  }, CONTEXT)
  const userAuthored = scoreSoftRetention({
    lines: ['已撤销的约束：不再要求兼容 0.6 版本'],
    source: 'constraint:u3',
    retentionClass: 'non-essential-history',
  }, CONTEXT)
  assert.equal(pluginAuthored.components.sourceBucket, 'plugin')
  assert.equal(pluginAuthored.components.sourceWeight, SOURCE_WEIGHTS.plugin)
  assert.equal(userAuthored.components.sourceBucket, 'user')
  assert.equal(userAuthored.components.sourceWeight, SOURCE_WEIGHTS.user)
  assert.ok(
    pluginAuthored.components.sourceWeight < userAuthored.components.sourceWeight,
    '插件自产的来源权重必须低于真实用户消息',
  )
  // 评分结果不携带任何保护/置信度语义：只有 score 与分量。
  for (const key of ['protected', 'confidence', 'verified', 'trust', 'safe']) {
    assert.equal(key in pluginAuthored, false, `评分结果不得出现 ${key} 字段（戒律：不是置信度/安全隔离）`)
  }
})

test('F1-3 stale/unverified 证据的 basis_trust 低分，valid 高分', () => {
  const stale = scoreSoftRetention({ lines: ['stale 证据 t1：指纹不匹配'], evidenceStatus: 'stale', retentionClass: 'stale-evidence' }, CONTEXT)
  const unverified = scoreSoftRetention({ lines: ['unverified 证据 t2：未绑定指纹'], evidenceStatus: 'unverified', retentionClass: 'unverified-evidence' }, CONTEXT)
  const valid = scoreSoftRetention({ lines: ['有效证据 t3：指纹一致'], evidenceStatus: 'valid' }, CONTEXT)
  const unstated = scoreSoftRetention({ lines: ['未决问题：哪里丢了？'], retentionClass: 'open-question' }, CONTEXT)
  assert.equal(stale.components.basisTrust, BASIS_TRUST.stale)
  assert.equal(unverified.components.basisTrust, BASIS_TRUST.unverified)
  assert.equal(valid.components.basisTrust, BASIS_TRUST.valid)
  assert.equal(unstated.components.basisTrust, BASIS_TRUST_UNSTATED)
  assert.ok(stale.components.basisTrust < unstated.components.basisTrust, 'stale 必须低于「无证据语义」的中性档')
  assert.ok(valid.components.basisTrust > unstated.components.basisTrust, 'valid 必须高于中性档')
})

test('F1-4 反复被回读的历史 hits 提级（对数压缩，饱和封顶）', () => {
  const never = scoreSoftRetention({ lines: ['历史 h'], recordId: 'r0', retentionClass: 'non-essential-history' }, { ...CONTEXT, retrievalHits: {} })
  const once = scoreSoftRetention({ lines: ['历史 h'], recordId: 'r1', retentionClass: 'non-essential-history' }, { ...CONTEXT, retrievalHits: { r1: 1 } })
  const often = scoreSoftRetention({ lines: ['历史 h'], recordId: 'r2', retentionClass: 'non-essential-history' }, { ...CONTEXT, retrievalHits: { r2: 4 } })
  const saturated = scoreSoftRetention({ lines: ['历史 h'], recordId: 'r3', retentionClass: 'non-essential-history' }, { ...CONTEXT, retrievalHits: { r3: HITS_SATURATION * 100 } })
  assert.ok(never.components.hitBoost === 0, '没有回读记录时 hitBoost 如实为 0')
  assert.ok(once.score < often.score, '回读次数多者分值更高')
  assert.ok(often.score < saturated.score, '提级单调不减')
  assert.equal(saturated.components.hitBoost, 1, '超过饱和点后 hitBoost 封顶为 1')
  assert.ok(once.components.hitBoost < 1 && once.components.hitBoost > 0, '1 次回读处于 (0,1) 区间')
  assert.equal(hitBoostOf(0), 0)
  assert.equal(hitBoostOf(-3), 0)
  assert.equal(hitBoostOf(Number.NaN), 0)
})

test('F1-5 硬保护项不参与打分：评分器没有硬保护类目入口，也不会输出保护语义', () => {
  // 评分器的输入面只有软保留候选（lines/source/evidenceStatus/recordId/retentionClass）。
  // 硬保护类目（human-request/unclosed-call/…）不存在任何映射：把它喂进来也
  // 只会按「无信号」处理，绝不会产生「受保护」的结果——保护语义在 guard 与
  // 保护集层，评分器无从干预（这是接入侧约定：硬保护项根本不进这条管道）。
  const fedAnyway = scoreSoftRetention({
    lines: ['当前人类请求：修复开关'],
    retentionClass: 'human-request',
    source: 'user',
  }, CONTEXT)
  assert.ok(Number.isFinite(fedAnyway.score), '评分永远只是个有限数，不是保护判定')
  assert.equal('strength' in fedAnyway, false)
  assert.equal('protected' in fedAnyway, false)
  assert.equal(sourceBucketForRetentionItem({ retentionClass: 'human-request', source: 'user' }), 'user', '来源档位映射不含硬保护特殊分支')
})

test('F1-6 确定性：同输入同输出（同分候选的次序交给接入侧的类目兜底）', () => {
  const candidate = { lines: ['进度 p1 工具 read 状态 done'], recordId: 'r1', retentionClass: 'non-essential-history' }
  const first = scoreSoftRetention(candidate, CONTEXT)
  const second = scoreSoftRetention({ ...candidate }, { ...CONTEXT })
  assert.deepEqual(second, first, '同输入必须产生逐字段相同的输出')
  assert.deepEqual(IMPORTANCE_WEIGHTS, Object.freeze({ relevance: 0.5, source: 0.3, basis: 0.1, hits: 0.1 }), '权重常量冻结，禁止静默漂移')
  // 同分的两条不同候选：分值一致，排序由接入侧按类目次序兜底（无随机）。
  const twinA = scoreSoftRetention({ lines: ['历史甲'], source: 'decision', retentionClass: 'rejected-option' }, CONTEXT)
  const twinB = scoreSoftRetention({ lines: ['历史乙'], source: 'decision', retentionClass: 'rejected-option' }, CONTEXT)
  assert.equal(twinB.score, twinA.score, '正文无重叠、同来源、同状态的候选必须同分')
})

test('F1-7 纯函数：不读写文件、不碰宿主、无副作用（含诚实边界）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mclimp-'))
  try {
    // 在有可写目录的进程里跑评分：不得创建或改写任何文件。
    const before = await readFile(path.join(root, 'sentinel.txt'), 'utf8').catch(() => null)
    const outcome = scoreSoftRetention({ lines: ['历史'], recordId: 'r1' }, { ...CONTEXT, retrievalHits: { r1: 2 } })
    assert.ok(Number.isFinite(outcome.score))
    const after = await readFile(path.join(root, 'sentinel.txt'), 'utf8').catch(() => null)
    assert.equal(after, before, '评分器不得写文件')
    await writeFile(path.join(root, 'sentinel.txt'), 'x', 'utf8')
    const unchanged = scoreSoftRetention({ lines: ['历史'], recordId: 'r1' }, { ...CONTEXT, retrievalHits: { r1: 2 } })
    assert.equal(unchanged.score, outcome.score, '评分不受外部文件状态影响（同输入同输出）')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('bigram 与模板骨架剥离：标题/依据行不进相关度，正文 bigram 可比', () => {
  assert.deepEqual([...bigramsOf('')], [])
  assert.deepEqual([...bigramsOf('a')], [])
  assert.deepEqual([...bigramsOf('ab')], ['ab'])
  assert.equal(bigramsOf('a b').size, bigramsOf('ab').size, '空白不参与 bigram')
  const stripped = stripTemplateSkeleton([
    '■ 软保留·非必要历史（可丢弃）',
    '依据/释放：分支结束即可丢',
    '进度 p1 工具 read 状态 done',
    '',
  ])
  assert.deepEqual(stripped, ['进度 p1 工具 read 状态 done'])
  assert.ok(relevanceOf('进度 p1 工具 read 状态 done', 'read 工具进度状态') > 0)
  assert.equal(relevanceOf('甲乙丙', '丁戊己'), 0)
})

test('formatImportanceReason：分量逐项可见，不给黑盒分', () => {
  const scored = scoreSoftRetention({
    lines: ['历史：修复开关'],
    source: 'constraint:u1',
    evidenceStatus: 'stale',
    recordId: 'r1',
  }, { ...CONTEXT, retrievalHits: { r1: 3 } })
  const line = formatImportanceReason(scored)
  assert.match(line, /重要度 \d\.\d{2}（/)
  assert.match(line, /相关性 0\.\d{2}×0\.5/)
  assert.match(line, /来源 user 1\.00×0\.3/)
  assert.match(line, /证据 stale 0\.30×0\.1/)
  assert.match(line, /回读 3 次→0\.\d{2}×0\.1/)
})
