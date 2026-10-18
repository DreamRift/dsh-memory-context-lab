/**
 * T3 / F-09：弱候选置信度统一。
 *
 * 0.11.0 之前「弱候选」只是回注文案里的一个说法：检索通道的 exact 后验内联在
 * searchRecords 里，弱候选诊断（queryDetailed）另有一套判定，两边口径迟早漂移；
 * 弱候选也没有可机读的置信度字段，下游只能靠字符串推断「这条算不算命中」。
 *
 * 本套件钉住新契约：
 * 1. exact 后验是**一个纯函数**（exactPostfilterHit），检索通道与弱候选共用；
 * 2. 弱指针显式带 weakPointer:true / isHit:false / confidence:{kind:'weak',…}；
 * 3. 弱指针不通过 exact 后验就如实丢弃（「弱」不是免责条款）；
 * 4. 回注文案写明「弱指针（不是命中），只给 ID，不计入回读计数」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyExactPostfilter, exactPostfilterHit } from '../src/v2/retrieval.mjs'

test('T3 纯函数：exact 后验要求每个 token 都作为子串出现（大小写不敏感）', () => {
  assert.equal(exactPostfilterHit({ exactTokens: ['a.md'], body: 'see A.MD here' }), true)
  assert.equal(exactPostfilterHit({ exactTokens: ['a.md'], body: 'no such file' }), false)
  // 多约束是 AND：只命中一个不算通过。
  assert.equal(exactPostfilterHit({ exactTokens: ['a.md', 'b.md'], body: 'a.md only' }), false)
  assert.equal(exactPostfilterHit({ exactTokens: ['a.md', 'b.md'], body: 'a.md and b.md' }), true)
  // 空约束恒真（没有约束就没有后验，不是「全部拒绝」）。
  assert.equal(exactPostfilterHit({ exactTokens: [], body: 'anything' }), true)
  assert.equal(exactPostfilterHit({}), true)
  // 元数据海明也算数：短语可以落在索引元数据里，不必只在正文。
  assert.equal(exactPostfilterHit({ exactTokens: ['call-1'], body: '', haystack: 'refs call-1' }), true)
  assert.equal(exactPostfilterHit({ exactTokens: ['call-1'], body: '', haystack: '' }), false)
  // 空 token 被忽略，不把空串当约束（否则恒真会掩盖错误）。
  assert.equal(exactPostfilterHit({ exactTokens: ['', '  '], body: 'x' }), true)
})

test('T3 共用驱动：读不到正文的候选如实丢弃，取不到条目的候选也丢弃', async () => {
  const candidates = new Map([
    ['ok', { id: 'ok' }],
    ['nobody', { id: 'nobody' }],
    ['noentry', { id: 'noentry' }],
  ])
  const verified = await applyExactPostfilter({
    exactTokens: ['needle'],
    candidates,
    readBody: async (id) => (id === 'nobody' ? { ok: false } : { ok: true, payloadText: 'has needle inside' }),
    haystackOf: () => '',
    entryOf: (id) => (id === 'noentry' ? null : { id }),
  })
  assert.deepEqual([...verified.keys()], ['ok'])
})

test('T3 弱指针字段：诊断面透出的 weak 条目带可机读的 matchedTerms/coverage/score', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createLocalLexicalBackend } = await import('../src/v2/local-lexical-backend.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'mcl-weak-pointer-'))
  try {
    const backend = createLocalLexicalBackend({ directory: dir })
    const detail = await backend.queryDetailed('alpha', { exact: [], limit: 5, weakLimit: 3 })
    // 空索引也要如实返回三个字段，而不是 undefined（调用方按数组消费）。
    assert.ok(Array.isArray(detail.admitted), 'admitted 必须是数组')
    assert.ok(Array.isArray(detail.weak), 'weak 必须是数组（可为空）')
    assert.ok(Array.isArray(detail.oovTerms), 'oovTerms 必须是数组')
    for (const entry of detail.weak) {
      assert.equal(typeof entry.id, 'string', '弱条目必须带记录 ID')
      assert.ok(Array.isArray(entry.matchedTerms), '弱条目必须带命中词元（可机读，不靠文案）')
      assert.equal(typeof entry.coverage, 'number', '弱条目必须带覆盖度数值')
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('T3 回注文案：弱指针明确写「不是命中」「只给 ID」「不计入回读计数」', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'src', 'v2', 'client-adapter.mjs'), 'utf8')
  // 文案是模型看到的那段字面量；三条限定必须同时在。
  assert.match(source, /弱指针（不是命中）/)
  assert.match(source, /只给 ID/)
  assert.match(source, /不计入回读计数/)
  // 结构字段必须写进命中对象，而不是只留在注释里。
  assert.match(source, /weakPointer: true/)
  assert.match(source, /isHit: false/)
  assert.match(source, /kind: 'weak'/)
  assert.match(source, /exactVerified: pair\.exactVerified/)
})

test('T3 单一判定：检索通道与弱候选都调用同一个纯函数', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const retrieval = readFileSync(join(here, '..', 'src', 'v2', 'retrieval.mjs'), 'utf8')
  const adapter = readFileSync(join(here, '..', 'src', 'v2', 'client-adapter.mjs'), 'utf8')
  // 检索通道走共用驱动，不再内联一份判定。
  assert.match(retrieval, /applyExactPostfilter\(\{/)
  assert.equal(/const ok = exactTokens\.every/.test(retrieval), false, '检索通道不得再内联判定')
  // 弱候选直接用同一个纯函数。
  assert.match(adapter, /exactPostfilterHit\(\{/)
})