/**
 * v2 证据原子提取（P3-1/2/3）测试：正文反向解析、类型化提取（退出码/测试/
 * 错误签名/版本/保守摘录）、unknown 不猜成功、完整事实去重（同键合并、数值/
 * 否定差异为更正或冲突、同输出两次执行保留两个事件身份）、先分桶再近似归组
 * （候选对上限、桶溢出截断如实上报）。全部纯函数、确定性断言（两次运行字节一致）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATOM_ATTRIBUTES,
  COMPARE_WINDOW,
  EXCERPT_MAX_CHARS,
  GROUP_MAX_CANDIDATE_PAIRS,
  GROUP_SIMILARITY_THRESHOLD,
  MAX_BUCKET_SIZE,
  atomKey,
  bucketOf,
  conservativeExcerpt,
  extractAtoms,
  groupAtoms,
  mergeFacts,
  parseErrorSignature,
  parseOperationBody,
  parseSpanBody,
  parseTestSummary,
  parseVersionTokens,
  readExitSignal,
} from '../src/v2/evidence-atoms.mjs'
import { SPAN_KINDS } from '../src/v2/history.mjs'

/** 按 history.mjs buildOperationBody 的同一语法构造操作正文（parts 以 \n\n join）。 */
function operationBody(parts) {
  return parts.join('\n\n')
}

function operationMember({ body, tools = ['pwsh'], callIds = ['call_1'], start = 10, failed = false, pluginAuthored = false }) {
  return {
    recordId: 't00000001-r0001',
    nodeId: 'node-1',
    spanKind: SPAN_KINDS.OPERATION,
    tools,
    callIds,
    range: { start, end: start + 2 },
    body,
    pluginAuthored,
    createdAt: '2026-10-16T10:00:00.000Z',
    failed,
  }
}

// ---------------------------------------------------------------- 正文解析

test('parseOperationBody 反解 buildOperationBody 全形态（文本/推理/多段工具/失败结果）', () => {
  const body = operationBody([
    '先跑测试再收尾。',
    '[推理]\n需要先确认基线。',
    '[工具] pwsh\n参数：{"command":"npm test"}',
    '[结果]\n33 套 465 项全绿',
    '[工具] read\n参数：{"file_path":"a.txt"}',
    '[失败结果]\nError: ENOENT',
  ])
  const parsed = parseOperationBody(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.assistantText, '先跑测试再收尾。')
  assert.equal(parsed.reasoning, '需要先确认基线。')
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].name, 'pwsh')
  // 尾随 join 换行被解析器剥掉：与生成端 trim 后的参数逐字一致。
  assert.equal(parsed.entries[0].arguments, '{"command":"npm test"}')
  assert.equal(parsed.entries[0].text, '33 套 465 项全绿')
  assert.equal(parsed.entries[0].failed, false)
  assert.equal(parsed.entries[1].failed, true)
  assert.equal(parsed.entries[1].text, 'Error: ENOENT')
})

test('parseOperationBody 参数跨行（含空行）不被切断', () => {
  const args = '{\n  "command": "npm test",\n\n  "description": "x"\n}'
  const body = operationBody(['[工具] pwsh\n参数：' + args, '[结果]\nok'])
  const parsed = parseOperationBody(body)
  assert.equal(parsed.ok, true)
  const restored = parsed.entries[0].arguments
  // 内部空行保留、尾随 join 换行剥掉：逐字节等于原始参数。
  assert.equal(restored, args)
  const round = JSON.parse(restored)
  assert.equal(round.command, 'npm test')
})

test('parseOperationBody 无结构标记 → ok:false（不猜）', () => {
  assert.deepEqual(parseOperationBody(''), { ok: false, reason: 'empty' })
  assert.deepEqual(parseOperationBody('纯助手正文，没有任何标记。'), { ok: false, reason: 'no-structure-markers' })
})

test('parseSpanBody 只认已知跨度种类的头；正文里的伪头不当头', () => {
  const body = '--- seq:5 ' + SPAN_KINDS.USER_TEXT + ' ---\n用户第一句\n\n' +
    '--- seq:6 ' + SPAN_KINDS.ASSISTANT_TEXT + ' ---\n看起来像 --- seq:99 fake --- 的行\n'
  const parsed = parseSpanBody(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.spans.length, 2)
  assert.equal(parsed.spans[0].seq, 5)
  assert.equal(parsed.spans[0].kind, SPAN_KINDS.USER_TEXT)
  assert.equal(parsed.spans[0].text.trim(), '用户第一句')
  // 未知 kind 的头只是正文。
  assert.equal(parsed.spans[1].text.includes('--- seq:99 fake ---'), true)
  assert.deepEqual(parseSpanBody(''), { ok: false, reason: 'empty' })
  assert.deepEqual(parseSpanBody('没有头的正文'), { ok: false, reason: 'no-span-headers' })
})

// ---------------------------------------------------------------- 信号解析

test('readExitSignal：显式 exit code / isError；都没有是 null（unknown 不猜成功）', () => {
  assert.deepEqual(readExitSignal('done [exit code: 1]'), { kind: 'exit', code: 1 })
  assert.deepEqual(readExitSignal('退出码：2'), { kind: 'exit', code: 2 })
  assert.deepEqual(readExitSignal('{"isError":true}'), { kind: 'error' })
  assert.equal(readExitSignal('33 套 465 项全绿'), null)
  assert.equal(readExitSignal(''), null)
})

test('parseTestSummary：中文全绿/失败与英文 passed/failed；认不出是 null', () => {
  const green = parseTestSummary('33 套 465 项全绿')
  assert.deepEqual({ total: green.total, passed: green.passed, failed: green.failed }, { total: 465, passed: 465, failed: 0 })
  assert.equal(green.summary.includes('全绿'), true)
  const mixed = parseTestSummary('12 passed\n3 failed')
  assert.deepEqual({ total: mixed.total, passed: mixed.passed, failed: mixed.failed }, { total: 15, passed: 12, failed: 3 })
  assert.equal(mixed.summary.includes('存在失败'), true)
  const onlyTotal = parseTestSummary('465 tests')
  assert.deepEqual({ total: onlyTotal.total, passed: onlyTotal.passed, failed: onlyTotal.failed }, { total: 465, passed: 0, failed: 0 })
  assert.equal(parseTestSummary('no numbers here'), null)
})

test('parseVersionTokens / parseErrorSignature / conservativeExcerpt', () => {
  assert.deepEqual(parseVersionTokens('node 22.14.0，version: 0.10.0'), ['22.14.0', '0.10.0'])
  assert.deepEqual(parseVersionTokens('nothing'), [])
  assert.equal(parseVersionTokens('node 22.14.0 再 node 22.14.0').length, 1)
  assert.equal(parseErrorSignature('plain\nError: ENOENT no such file'), 'Error: ENOENT no such file')
  assert.equal(parseErrorSignature('失败原因：连接超时'), '失败原因：连接超时')
  assert.equal(parseErrorSignature('no error at all'), null)
  assert.equal(conservativeExcerpt('首行\n中间\n尾行'), '首行\n尾行')
  assert.equal(conservativeExcerpt(''), '')
  const clipped = conservativeExcerpt('x'.repeat(400))
  assert.equal(clipped.length <= EXCERPT_MAX_CHARS + 1, true)
})

// ---------------------------------------------------------------- 类型化提取

test('extractAtoms：成功操作提命令 + 测试摘要（entity 取 call locator）', () => {
  const body = operationBody([
    '先跑测试。',
    '[工具] pwsh\n参数：{"command":"npm test"}',
    '[结果]\n33 套 465 项全绿',
  ])
  const member = operationMember({ body })
  const atoms = extractAtoms(member)
  assert.equal(atoms.length, 2)
  const command = atoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.COMMAND)
  assert.equal(command.value, 'npm test')
  assert.equal(command.entity, 'npm test')
  assert.equal(command.polarity, 'positive')
  const summary = atoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.TEST_SUMMARY)
  assert.equal(summary.value, '465 项、465 通过、全绿')
  assert.deepEqual(summary.sourceRefs, [{
    recordId: 't00000001-r0001',
    nodeId: 'node-1',
    callId: 'call_1',
    seq: 10,
    at: '2026-10-16T10:00:00.000Z',
  }])
  // 有类型化信号就不落摘录。
  assert.equal(atoms.some((atom) => atom.attribute === ATOM_ATTRIBUTES.EXCERPT), false)
})

test('extractAtoms：exit code 1 → 负面退出码原子；0 → 正面', () => {
  const failBody = operationBody([
    '[工具] pwsh\n参数：{"command":"git status"}',
    '[结果]\n[exit code: 1] bad revision',
  ])
  const failAtoms = extractAtoms(operationMember({ body: failBody }))
  const failExit = failAtoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.EXIT_CODE)
  assert.equal(failExit.value, 'exit 1')
  assert.equal(failExit.polarity, 'negative')

  const okBody = operationBody([
    '[工具] pwsh\n参数：{"command":"git status"}',
    '[结果]\n[exit code: 0] clean tree',
  ])
  const okAtoms = extractAtoms(operationMember({ body: okBody }))
  const okExit = okAtoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.EXIT_CODE)
  assert.equal(okExit.value, 'exit 0')
  assert.equal(okExit.polarity, 'positive')
})

test('extractAtoms：失败但正文无信号 → unknown 失败，不猜成功也不编退出码', () => {
  const body = operationBody([
    '[工具] pwsh\n参数：{"command":"npm test"}',
    '[失败结果]\nSomething went wrong',
  ])
  const atoms = extractAtoms(operationMember({ body }))
  const exit = atoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.EXIT_CODE)
  assert.equal(exit.value, 'unknown（结果标记失败，正文无退出码）')
  assert.equal(exit.polarity, 'negative')
  // 有 command 形态可回读，正文又无类型化信号 → 不落摘录。
  assert.equal(atoms.some((atom) => atom.attribute === ATOM_ATTRIBUTES.EXCERPT), false)
})

test('extractAtoms：失败标记 + 明确错误行 → 错误签名（负面），失败但无错误行不编造', () => {
  const sigBody = operationBody([
    '[工具] pwsh\n参数：{"command":"npm test"}',
    '[失败结果]\nError: ECONNREFUSED',
  ])
  const sigAtoms = extractAtoms(operationMember({ body: sigBody }))
  const sig = sigAtoms.find((atom) => atom.attribute === ATOM_ATTRIBUTES.ERROR_SIGNATURE)
  assert.equal(sig.value, 'Error: ECONNREFUSED')
  assert.equal(sig.polarity, 'negative')
  assert.equal(sigAtoms.some((atom) => atom.attribute === ATOM_ATTRIBUTES.EXCERPT), false)
})

test('extractAtoms：未知工具走保守摘录（不硬解析）', () => {
  const body = operationBody([
    '[工具] web_search\n参数：{"queries":["层级压缩"]}',
    '[结果]\n搜索结果第一行\n中间\n搜索结果最后一行',
  ])
  const atoms = extractAtoms(operationMember({ body, tools: ['web_search'] }))
  assert.equal(atoms.length, 1)
  assert.equal(atoms[0].attribute, ATOM_ATTRIBUTES.EXCERPT)
  assert.equal(atoms[0].value, '搜索结果第一行\n搜索结果最后一行')
})

test('extractAtoms：不可解析操作正文 → 整段保守摘录', () => {
  const atoms = extractAtoms(operationMember({ body: '没有任何结构标记的正文首行\n尾行' }))
  assert.equal(atoms.length, 1)
  assert.equal(atoms[0].attribute, ATOM_ATTRIBUTES.EXCERPT)
  assert.equal(atoms[0].value, '没有任何结构标记的正文首行\n尾行')
})

test('extractAtoms：普通历史段逐 span 摘录；pluginAuthored 透传给下游', () => {
  const body = '--- seq:5 ' + SPAN_KINDS.USER_TEXT + ' ---\n用户第一句\n' +
    '--- seq:6 ' + SPAN_KINDS.USER_TEXT + ' ---\n用户第二句\n'
  const member = {
    recordId: 't00000001-r0002',
    nodeId: 'node-2',
    spanKind: SPAN_KINDS.USER_TEXT,
    tools: [],
    callIds: [],
    range: { start: 5, end: 6 },
    body,
    pluginAuthored: true,
    createdAt: '2026-10-16T11:00:00.000Z',
    failed: false,
  }
  const atoms = extractAtoms(member)
  assert.equal(atoms.length, 2)
  assert.equal(atoms[0].entity, 'turn.user:5')
  assert.equal(atoms[0].value, '用户第一句')
  assert.equal(atoms[0].attribute, ATOM_ATTRIBUTES.SPAN_EXCERPT)
  assert.equal(atoms[0].pluginAuthored, true)
  assert.equal(atoms[1].entity, 'turn.user:6')
  // 空 body 直接没有原子。
  assert.deepEqual(extractAtoms({ ...member, body: '' }), [])
})

test('extractAtoms 确定性：同输入两次运行字节一致', () => {
  const body = operationBody([
    '[工具] pwsh\n参数：{"command":"npm test"}',
    '[结果]\n33 套 465 项全绿\nnode 22.14.0',
  ])
  const member = operationMember({ body })
  assert.deepEqual(extractAtoms(member), extractAtoms(member))
})

// ---------------------------------------------------------------- 完整事实去重

function commandAtom(entity, value, { seq = 10, callId = 'call_a', recordId = 't00000001-r0001' } = {}) {
  return {
    kind: 'atom',
    key: atomKey({ scope: 'session', entity, attribute: ATOM_ATTRIBUTES.COMMAND, value, polarity: 'positive' }),
    scope: 'session',
    entity,
    attribute: ATOM_ATTRIBUTES.COMMAND,
    value,
    polarity: 'positive',
    qualifier: null,
    sourceRefs: [{ recordId, nodeId: null, callId, seq, at: null }],
  }
}

test('mergeFacts：同输出两次执行合并为一个事实但保留两个事件身份', () => {
  const facts = mergeFacts([
    commandAtom('npm test', 'npm test', { seq: 10, callId: 'call_a', recordId: 't00000001-r0001' }),
    commandAtom('npm test', 'npm test', { seq: 40, callId: 'call_b', recordId: 't00000001-r0009' }),
  ])
  assert.equal(facts.length, 1)
  assert.equal(facts[0].sourceRefs.length, 2)
  assert.deepEqual(facts[0].sourceRefs.map((ref) => ref.callId), ['call_a', 'call_b'])
  assert.equal(facts[0].relation, null)
})

test('mergeFacts：数值差异 → 更正（后值 supersedes 前值，两者必选）', () => {
  const facts = mergeFacts([
    {
      ...commandAtom('npm test', '465 项、465 通过、全绿', { seq: 10, callId: 'call_a' }),
      attribute: ATOM_ATTRIBUTES.TEST_SUMMARY,
    },
    {
      ...commandAtom('npm test', '450 项、450 通过、全绿', { seq: 50, callId: 'call_b' }),
      attribute: ATOM_ATTRIBUTES.TEST_SUMMARY,
    },
  ])
  assert.equal(facts.length, 2)
  for (const fact of facts) {
    assert.equal(fact.relation, 'correction')
    assert.equal(fact.required, true)
  }
  facts.sort((a, b) => b.value.localeCompare(a.value))
  assert.deepEqual(facts[1].supersedes, [facts[0].key])
})

test('mergeFacts：极性翻转 → 冲突（都必选，不吞并任何一方）', () => {
  const facts = mergeFacts([
    {
      ...commandAtom('git status', 'exit 1', { seq: 10, callId: 'call_a' }),
      attribute: ATOM_ATTRIBUTES.EXIT_CODE,
      polarity: 'negative',
    },
    {
      ...commandAtom('git status', 'exit 0', { seq: 60, callId: 'call_b' }),
      attribute: ATOM_ATTRIBUTES.EXIT_CODE,
      polarity: 'positive',
    },
  ])
  assert.equal(facts.length, 2)
  for (const fact of facts) {
    assert.equal(fact.relation, 'conflict')
    assert.equal(fact.required, true)
    assert.deepEqual(fact.supersedes, [])
  }
})

test('mergeFacts：负面事实单条也必选；输出按首见 seq 排序', () => {
  const facts = mergeFacts([
    { ...commandAtom('a', 'ok-late', { seq: 30, callId: 'c2' }) },
    { ...commandAtom('b', 'exit 1', { seq: 10, callId: 'c1' }), polarity: 'negative' },
  ])
  assert.equal(facts.length, 2)
  assert.equal(facts[0].entity, 'b')
  assert.equal(facts[0].required, true)
  assert.equal(facts[1].required, false)
})

// ---------------------------------------------------------------- 分桶与近似归组

test('groupAtoms：桶内近似归组（Jaccard ≥ 阈值）与不相似分离', () => {
  const facts = [
    commandAtom('npm test', 'npm test', { seq: 10, callId: 'a' }),
    commandAtom('npm test', 'npm run test', { seq: 20, callId: 'b' }),
    commandAtom('git', 'git status', { seq: 30, callId: 'c' }),
  ]
  const result = groupAtoms(facts)
  assert.equal(result.truncated, false)
  assert.equal(result.pairsCompared <= GROUP_MAX_CANDIDATE_PAIRS, true)
  // 'npm test' 与 'npm run test' 同组（相似 ≥ 0.6），git 单独一组。
  const npmGroup = result.groups.find((group) => group.keys.length === 2)
  assert.ok(npmGroup, '应有 2 键的近似组')
  assert.equal(npmGroup.similarity >= GROUP_SIMILARITY_THRESHOLD, true)
  assert.equal(result.groups.length, 2)
})

test('groupAtoms：不同 entity 分属不同桶，永不比较（相似也分开）', () => {
  const facts = [
    commandAtom('a', 'npm test', { seq: 10, callId: 'a' }),
    commandAtom('b', 'npm test', { seq: 20, callId: 'b' }),
  ]
  const result = groupAtoms(facts)
  assert.equal(result.groups.length, 2)
  assert.equal(result.pairsCompared, 0)
})

test('bucketOf：桶键 = scope|entity|family', () => {
  assert.equal(
    bucketOf({ scope: 'session', entity: 'npm test', attribute: ATOM_ATTRIBUTES.COMMAND }),
    'session|npm test|command',
  )
  assert.equal(
    bucketOf({ scope: 'session', entity: 'npm test', attribute: ATOM_ATTRIBUTES.EXIT_CODE }),
    'session|npm test|outcome',
  )
})

test('groupAtoms：桶超过 MAX_BUCKET_SIZE 截断如实上报', () => {
  const facts = []
  for (let index = 0; index < MAX_BUCKET_SIZE + 6; index += 1) {
    facts.push(commandAtom('npm test', 'npm test --run ' + index, { seq: 10 + index, callId: 'c' + index }))
  }
  const result = groupAtoms(facts)
  assert.equal(result.truncated, true)
  assert.ok(result.groups.length > 0)
  // 桶溢出后近似比较退化为最近 COMPARE_WINDOW 代表——候选对数仍然有界。
  assert.ok(result.pairsCompared <= (MAX_BUCKET_SIZE + 6) * COMPARE_WINDOW)
})

test('atomKey：完全相同才同键；值/极性差异分键', () => {
  const base = { scope: 'session', entity: 'e', attribute: ATOM_ATTRIBUTES.COMMAND, qualifier: null }
  const a = atomKey({ ...base, value: 'x', polarity: 'positive' })
  assert.equal(a, atomKey({ ...base, value: 'x', polarity: 'positive' }))
  assert.notEqual(a, atomKey({ ...base, value: 'y', polarity: 'positive' }))
  assert.notEqual(a, atomKey({ ...base, value: 'x', polarity: 'negative' }))
})
