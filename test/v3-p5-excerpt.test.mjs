/**
 * P5 T1：命中窗口、码点偏移与长查询有界化（domain 层）。
 *
 * 对应开发流程 §7.1/§7.2 R01：
 * - 927 字记录尾部才是答案时，窗口必须包含尾部事实，而不是固定首部；
 * - 中文、精确标识符/错误码、路径与多段落都要能被窗口选中；
 * - 长查询缩减必须保留尾部强实体（唯一错误码），不能只裁前缀；
 * - 所有偏移都是 **Unicode 码点半开区间**，emoji/代理对不得切断；
 * - chunk 索引只约束窗口搜索范围；索引缺失时现扫，能力不降级。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TOKENIZER_VERSION, tokenizeQuery } from '../src/v3/domain/retrieval/query.mjs'
import { CHUNK_SCHEMA_VERSION, chunkText } from '../src/v3/domain/retrieval/chunks.mjs'
import {
  EXCERPT_OFFSET_UNIT,
  QUERY_MAX_TERMS,
  boundQuery,
  selectExcerpt,
  selectExcerptTerms,
} from '../src/v3/domain/retrieval/excerpt.mjs'
import {
  SEARCH_EXCERPT_MAX_CHARS,
  SEARCH_EXCERPT_MAX_SPANS,
  SEARCH_OFFSET_UNIT,
} from '../src/v3/contracts/tools.mjs'

const TAIL_FACT = 'ERR_TAIL_X7'
const TAIL_TEXT = '开头无关内容。'.repeat(120) + ' 最终答案是 ' + TAIL_FACT + '，路径 C:/tmp/a-b.js。'

test('P5 分词契约版本登记，tokenizeQuery 语义不回归', () => {
  assert.equal(TOKENIZER_VERSION, 'cjk-uni-bi-v1')
  assert.equal(CHUNK_SCHEMA_VERSION, 1)
  assert.deepEqual(tokenizeQuery('中文'), ['中', '文', '中文'])
})

test('R01：927 字记录尾部答案进入窗口（不再固定首部）', () => {
  assert.ok([...TAIL_TEXT].length > 800, '前置：正文足够长')
  const out = selectExcerpt(TAIL_TEXT, 'ERROR_CODE_Z9 最终答案 ' + TAIL_FACT, { maxChars: 160 })
  assert.equal(out.offsetUnit, EXCERPT_OFFSET_UNIT)
  assert.equal(out.text.includes(TAIL_FACT), true, '窗口必须包含尾部事实：' + out.text)
  assert.ok(out.spans.length >= 1)
  assert.ok(out.spans[0].start > 0, '窗口不是从头开始（首部不含答案）')
  assert.equal(out.truncated, true)
  // 窗口仍受 maxChars 约束（码点）
  assert.ok([...out.text].length <= 160 + 4, '窗口长度受 maxChars 约束（含多窗口连接符）')
})

test('中文/精确标识符/路径都由窗口命中', () => {
  const cases = [
    ['最终答案', '最终答案'],
    [TAIL_FACT, TAIL_FACT],
    ['a-b.js', 'C:/tmp/a-b.js'],
    ['ERR_TAIL_X7 错误码', 'ERR_TAIL_X7'],
  ]
  for (const [query, expected] of cases) {
    const out = selectExcerpt(TAIL_TEXT, query, { maxChars: 80 })
    assert.equal(out.text.includes(expected), true, query + ' → ' + out.text)
  }
})

test('码点偏移：emoji 前缀不导致半个代理对或 UTF-16 偏移混用', () => {
  const text = '😀'.repeat(50) + ' 关键结论 ERR_X1 收尾'
  const out = selectExcerpt(text, 'ERR_X1', { maxChars: 40 })
  const cps = [...text]
  assert.ok(out.spans.length >= 1)
  for (const span of out.spans) {
    assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end))
    assert.ok(span.start >= 0 && span.end <= cps.length && span.end > span.start)
    const slice = cps.slice(span.start, span.end).join('')
    assert.ok(!slice.includes('\uFFFD'))
  }
  const span = out.spans.find((item) => cps.slice(item.start, item.end).join('').includes('ERR_X1'))
  assert.ok(span !== undefined, '包含目标的 span 必须存在：' + JSON.stringify(out.spans))
  assert.ok(span.start < text.indexOf('ERR_X1'), 'span 是码点下标（小于 UTF-16 下标）')
  assert.ok(cps.slice(span.start, span.end).join('').includes('关键结论') || cps.slice(span.start, span.end).join('').includes('ERR_X1'))
})

test('多段落/互补窗口：两个远处事实都出现，span 互不重叠', () => {
  const text = 'A段'.repeat(40) + ' ERR_ONE_X1 ' + '填充'.repeat(160) + ' ERR_TWO_X2 结尾'
  const out = selectExcerpt(text, 'ERR_ONE_X1 ERR_TWO_X2', { maxChars: 48, maxSpans: 2 })
  assert.equal(out.text.includes('ERR_ONE_X1'), true, out.text)
  assert.equal(out.text.includes('ERR_TWO_X2'), true, out.text)
  assert.equal(out.spans.length, 2)
  assert.ok(out.spans[0].end <= out.spans[1].start, 'span 不得重叠')
})

test('无命中回退首部并如实标记 strategy=head', () => {
  const out = selectExcerpt(TAIL_TEXT, 'zqxwv qqzzxx', { maxChars: 50 })
  assert.equal(out.strategy, 'head')
  assert.deepEqual(out.spans, [{ start: 0, end: 50 }])
  assert.equal(out.text.length, 50)
})

test('chunk 索引：命中 chunk 内选窗；无命中 chunk 时回退现扫（不丢窗口）', () => {
  const { spans } = chunkText(TAIL_TEXT, { chunkSize: 120, overlap: 20 })
  const all = spans.map((span) => ({ start: span.start, end: span.end }))
  const within = spans.map((span) => ({ start: span.start, end: span.end }))
  const scoped = selectExcerpt(TAIL_TEXT, TAIL_FACT, { maxChars: 80, chunkSpans: within })
  // 最后一个 chunk 含尾部事实
  assert.equal(scoped.strategy, 'chunk-window')
  assert.equal(scoped.text.includes(TAIL_FACT), true)
  assert.ok(scoped.chunkHits >= 1)
  const miss = selectExcerpt(TAIL_TEXT, TAIL_FACT, { maxChars: 80, chunkSpans: [{ start: 0, end: 60 }] })
  assert.equal(miss.strategy, 'scan-fallback', 'chunk 索引没覆盖命中时必须现扫')
  assert.equal(miss.text.includes(TAIL_FACT), true)
  assert.ok(all.length >= 3)
})

test('长查询有界化：保留首部与尾部，唯一错误码不被裁掉', () => {
  const query = '甲'.repeat(100) + ' ' + TAIL_FACT
  const bounded = boundQuery(query, 40)
  assert.equal([...bounded].length, 40)
  assert.equal(bounded.includes(TAIL_FACT), true, bounded)
  assert.ok(bounded.startsWith('甲'))
  assert.equal(boundQuery('短查询', 40), '短查询')
  // 边界：1 与 0
  assert.equal([...boundQuery(query, 1)].length, 1)
  assert.equal(boundQuery(query, 0), query)
})

test('长查询缩减：强词元（数字/长词/分隔符）优先，尾部字面 needle 保留', () => {
  const distinctCjk = Array.from({ length: 80 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
  const query = distinctCjk + ' ' + TAIL_FACT
  const selected = selectExcerptTerms(query)
  assert.equal(selected.reduced, true)
  assert.ok(selected.terms.length <= QUERY_MAX_TERMS)
  assert.ok(selected.literals.includes('err_tail_x7'), '字面 needle 必须保留：' + JSON.stringify(selected.literals))
  const out = selectExcerpt(TAIL_TEXT, query, { maxChars: 80 })
  assert.equal(out.text.includes(TAIL_FACT), true, '缩减后仍能命中尾部错误码')
})

test('P1：自然问句里高频常用词不得把尾部唯一标识符挤出预算', () => {
  // 复现（0.15.0 P5 验收）：正文里「之前我们讨论过归档的结论是什么」重复 40 次，
  // 唯一答案 ERR_TAIL_X7 在尾部。查询同时含这些常用词与错误码。
  // 旧排序先比 covered.size（常用词单字/双字覆盖多），两个窗口全被常用词占满，
  // 实测 spans=[{0,161},{163,323}]，正文不含 ERR_TAIL_X7。
  const text = '之前我们讨论过归档的结论是什么，这里再复述一遍。'.repeat(40) + ' 最终答案是 ERR_TAIL_X7。'
  assert.ok([...text].length > 900, '前置：正文够长（实测 ' + [...text].length + ' 码点）')
  const out = selectExcerpt(text, '之前讨论的归档结论 ERR_TAIL_X7 是什么', { maxChars: 160, maxSpans: 2 })
  assert.equal(out.text.includes(TAIL_FACT), true, '尾部唯一标识符必须出现在窗口里：' + out.text)
  const factSpan = out.spans.find((span) => [...text].slice(span.start, span.end).join('').includes(TAIL_FACT))
  assert.ok(factSpan !== undefined, '必须有一个 span 覆盖标识符：' + JSON.stringify(out.spans))
  assert.ok(factSpan.start > 0, '覆盖标识符的窗口不是文首（首部只有常用词）')
  for (const span of out.spans) {
    assert.ok(span.end - span.start <= 160, '每个 span 都受 maxChars 约束：' + JSON.stringify(span))
  }
  assert.equal(out.truncated, true)
})

test('P1 排序承重：稀有命中同分时由 covered/count/complete 决定窗口（退化必红）', () => {
  // 同一条错误码出现两次：两个候选窗口的「稀有命中」完全同分，
  // 此时必须靠 covered.size/count/complete 把**旁边还有查询词**的那一处选出来。
  // 若把 covered/count/complete 三项从比较里置 0，退化到「最早起点」→ 选中前一处，
  // 本用例必红（定点变异 M2 实测）。
  const text = '早段 ' + 'ERR_REPEAT_A1' + ' 这里没有别的查询词。' + '填充'.repeat(120) + ' ' + 'ERR_REPEAT_A1' + ' 甲乙丙丁 后面还有内容。'
  assert.equal(text.indexOf('ERR_REPEAT_A1') < text.lastIndexOf('ERR_REPEAT_A1'), true, '前置：错误码出现两次')
  const out = selectExcerpt(text, 'ERR_REPEAT_A1 甲乙丙丁', { maxChars: 80, maxSpans: 1 })
  assert.equal(out.spans.length, 1)
  assert.equal(out.text.includes('ERR_REPEAT_A1'), true, out.text)
  assert.equal(out.text.includes('甲乙丙丁'), true, '必须选覆盖查询词更多的那一处：' + out.text)
  assert.ok(out.spans[0].start > text.indexOf('ERR_REPEAT_A1'), '起点晚于第一处错误码（不是最早起点）')
})

test('P2：吸附回文首不得突破 maxChars（同一预算里回收尾部）', () => {
  // 命中离文首 4 个码点：窗口 {4,44} 会被吸附成 {0,44}——旧实现只把 start 置 0，
  // 实测产出 44 码点窗口，突破 maxChars=40。
  const text = '引导行 ERR_A1 ' + '填充'.repeat(200)
  const out = selectExcerpt(text, 'ERR_A1', { maxChars: 40 })
  assert.equal(out.spans[0].start, 0, '离文首很近时仍吸附到 0（保留引导行）')
  for (const span of out.spans) {
    assert.ok(span.end - span.start <= 40, 'span 长度必须 ≤ maxChars：' + JSON.stringify(out.spans))
  }
  assert.equal(out.text.includes('ERR_A1'), true)
})

test('P2：span 之间有洞（互不相连）也必须标 truncated', () => {
  // 首窗口从 0 起、末窗口一直延伸到文末——只看首尾会误判「没截断」，
  // 中间真实的省略（两个窗口之间）随之不可见。
  const text = 'ERR_A1 ' + '填充'.repeat(100) + ' ERR_B2'
  const out = selectExcerpt(text, 'ERR_A1 ERR_B2', { maxChars: 30, maxSpans: 2 })
  assert.equal(out.spans.length, 2)
  assert.equal(out.spans[0].start, 0)
  assert.equal(out.spans[1].end, [...text].length)
  assert.ok(out.spans[1].start > out.spans[0].end, '前置：两个窗口之间确有缺口')
  assert.equal(out.truncated, true, '中间有洞时 truncated 必须为 true')
})

test('P3：boundQuery 尾部按实体保留，32 预算下错误码不被切成碎片', () => {
  const query = '很长的前缀文字'.repeat(6) + ' ' + TAIL_FACT
  const bounded = boundQuery(query, 32)
  assert.equal([...bounded].length, 32)
  assert.equal(bounded.endsWith(TAIL_FACT), true, '尾部标识符整体保留：' + bounded)
  assert.equal(bounded.includes('…'), true, '省略必须可见')
  // 实体自身超预算时才不得不截断——此时前导省略号明示「前面还有内容」。
  const oversized = boundQuery('ERR_' + 'X'.repeat(40), 20)
  assert.equal([...oversized].length, 20)
  assert.equal(oversized.startsWith('…'), true, '实体超预算时必须明示省略：' + oversized)
})

test('参数失败关闭：非法 maxChars / maxTerms 抛 V3ContractViolation', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '10']) {
    assert.throws(() => selectExcerpt('正文', '正文', { maxChars: bad }), (e) => e?.name === 'V3ContractViolation')
  }
  assert.throws(() => selectExcerptTerms('正文', { maxTerms: 0 }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => chunkText('正文', { chunkSize: 10 }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => chunkText('正文', { chunkSize: 64, overlap: 64 }), (e) => e?.name === 'V3ContractViolation')
})
/**
 * G1（C-G1-08 / C-G1-09 单一真源）：工具面声明的摘录预算/单位必须与域层默认值一致。
 *
 * 修 F02 时若在入口再写一个 160 字面量，两处预算迟早漂移（工具面显示 160、域层改成 200，
 * 或反之）。契约常量在 contracts/tools.mjs，本用例把它和 selectExcerpt 的默认行为钉在一起。
 */
test('G1：摘录预算与偏移单位只有一份真源（contracts ↔ domain 交叉核对）', () => {
  assert.equal(EXCERPT_OFFSET_UNIT, SEARCH_OFFSET_UNIT)
  assert.equal(SEARCH_EXCERPT_MAX_CHARS, 160)
  assert.equal(SEARCH_EXCERPT_MAX_SPANS, 2)
  const out = selectExcerpt('x'.repeat(300), 'x')
  assert.equal([...out.text].length, SEARCH_EXCERPT_MAX_CHARS, '域层默认 maxChars 必须等于工具面的摘录预算')
  assert.equal(out.truncated, true)
  assert.equal(out.offsetUnit, SEARCH_OFFSET_UNIT)
})
