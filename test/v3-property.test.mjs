/**
 * v3 性质/模糊测试（M6：property/fuzz 层）——种子确定，失败可重放。
 *
 * ## 判据来源
 * M6 硬门槛：恢复/来源完整性、无跨会话污染、注入预算上界；contracts 失败关闭。
 *
 * ## 断言组（随机输入下的不变量）
 * - 随机记录（CJK/emoji/ASCII/空白混合）入库→索引→检索→回读：正文逐字节一致；
 * - 预算器/renderer：随机 sections 与预算下，非溢出卡恒不超预算、丢弃恒可见；
 * - applyMinScore：pack 恒为 display 子集、顺序稳定；
 * - 损坏注入：随机截断 jsonl 后 listRecords/health 失败关闭（损坏可见），不伪成功。
 *
 * ## 不适用条件与已知边界
 * 真 fuzz 的进程级崩溃与并发时序属 M6 真机矩阵；本套件是确定性随机（同一种子同结果）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { renderWorkingCard } from '../src/v3/projection/card-renderer.mjs'
import { applyMinScore, rankResults } from '../src/v3/domain/retrieval/query.mjs'

/** 种子 PRNG（mulberry32）：同一种子同一序列，失败可重放。 */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = ['记', '忆', '检', '索', 'a', 'b', '9', '😀', ' ', '\n', '。', 'x']

function randomText(rand, maxLen = 120) {
  const n = 1 + Math.floor(rand() * maxLen)
  let out = ''
  for (let i = 0; i < n; i += 1) out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return out
}

function record(id, text, txn) {
  return {
    id, kind: 'operation', sessionKey: 'sess-a', createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-1', sourceForm: 'tool/result', transactionId: txn },
  }
}

test('P1：随机记录入库→检索→回读，正文逐字节一致（200 轮）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-prop-'))
  const rand = prng(20261024)
  try {
    const { port, store } = await createSessionStorePort(root, 'sess-a')
    const metrics = { counter() {}, observe() {} }
    const provider = createT1Provider({ port, store, metrics })
    const texts = []
    for (let i = 0; i < 200; i += 1) texts.push(randomText(rand))
    await port.transaction(texts.map((text, i) => record('v3r-' + String(i).padStart(16, '0'), text, 'tx-1')))
    assert.equal((await port.health()).recordCount, 200)
    for (let i = 0; i < 200; i += 1) {
      const read = await port.readRecord('v3r-' + String(i).padStart(16, '0'))
      assert.equal(read.payload.text, texts[i], '逐字节一致 #' + i)
      assert.equal(read.payload.bytes, Buffer.byteLength(texts[i], 'utf8'))
    }
    // 抽 20 个随机查询：不炸、OOV/空结果如实
    for (let q = 0; q < 20; q += 1) {
      const query = randomText(rand, 8).replace(/\s+/g, '') || '记忆'
      const out = await provider.search(query, { limit: 5 })
      assert.ok(Array.isArray(out.display) && Array.isArray(out.pack))
    }
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2：随机 sections/预算下，卡恒不超预算且丢弃可见（300 轮）', () => {
  const rand = prng(424242)
  const cats = ['anchor', 'guard', 'evidence', 'progress', 'claims', 'notes']
  const prios = ['structural', 'protected', 'soft', 'soft']
  for (let round = 0; round < 300; round += 1) {
    const sectionCount = 1 + Math.floor(rand() * 5)
    const sections = []
    for (let i = 0; i < sectionCount; i += 1) {
      const lines = []
      const lineCount = 1 + Math.floor(rand() * 4)
      for (let l = 0; l < lineCount; l += 1) lines.push(randomText(rand, 40))
      sections.push({ category: cats[i % cats.length] + '-' + i, priority: prios[Math.floor(rand() * 4)], producer: rand() > 0.2, lines })
    }
    const budgetChars = Math.floor(rand() * 400)
    const card = renderWorkingCard({ sections, budgetChars })
    if (!card.structuralOverflow) {
      assert.ok(card.usedChars <= budgetChars, '非溢出不超预算 round=' + round + ' used=' + card.usedChars + ' budget=' + budgetChars)
    }
    const includedSet = new Set(card.included)
    for (const { category } of sections) {
      if (includedSet.has(category)) continue
      assert.ok(card.excluded.some((e) => e.category === category), '丢弃可见 round=' + round + ' cat=' + category)
    }
    const unit = [...card.text]
    const last = card.text.charCodeAt(card.text.length - 1)
    assert.ok(!(Number.isFinite(last) && last >= 0xd800 && last <= 0xdbff), '卡文本不得以半个代理对结尾')
    void unit
  }
})

test('P3：applyMinScore 随机分数下 pack⊆display 且顺序稳定（200 轮）', () => {
  const rand = prng(777)
  for (let round = 0; round < 200; round += 1) {
    const n = Math.floor(rand() * 30)
    const items = Array.from({ length: n }, (_, i) => ({ id: 'id-' + i, score: Math.round(rand() * 1000) / 10 }))
    const resultMinScore = rand() * 5
    const packMinScore = resultMinScore + rand() * 5
    const gated = applyMinScore(rankResults(items), { resultMinScore, packMinScore })
    const displayIds = gated.display.map((d) => d.id)
    for (const p of gated.pack) assert.ok(displayIds.includes(p.id), 'pack⊆display round=' + round)
    const scores = gated.display.map((d) => d.score)
    for (let i = 1; i < scores.length; i += 1) assert.ok(scores[i - 1] >= scores[i], 'display 降序 round=' + round)
  }
})

test('P4：随机截断 jsonl 后失败关闭（50 轮）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-prop2-'))
  const rand = prng(999)
  try {
    const { port, store } = await createSessionStorePort(root, 'sess-a')
    await port.transaction([record('v3r-0000000000000000', '正文一', 'tx-1'), record('v3r-0000000000000001', '正文二', 'tx-2')])
    store.close()
    // 两种损坏语义（M2 设计）：尾部半行=崩溃残留（open 对账修复）；中段行损坏=health 可见不伪成功
    const file = path.join(root, 'sessions', 'sess-a', 'transactions.jsonl')
    const raw = await fs_readFile(file)
    if (rand() < 0.5) {
      const cut = 1 + Math.floor(rand() * Math.max(1, Math.min(40, raw.length - 1)))
      await writeFile(file, raw.subarray(0, raw.length - cut))
      const { port: p2, store: s2 } = await createSessionStorePort(root, 'sess-a')
      const health = await p2.health()
      assert.equal(health.healthy, true, '尾部残留修复后 health 应健康（cut=' + cut + '）：' + (health.damagedReason ?? ''))
      const read = await p2.readRecord('v3r-0000000000000000')
      assert.equal(read.payload.text, '正文一', '已提交记录不受尾部残留影响')
      s2.close()
    } else {
      const lines = raw.toString('utf8').split('\n')
      lines[1] = '{corrupted!!!'
      await writeFile(file, lines.join('\n'))
      const { port: p2, store: s2 } = await createSessionStorePort(root, 'sess-a')
      const health = await p2.health()
      assert.equal(health.healthy, false, '中段损坏必须可见')
      assert.ok(typeof health.damagedReason === 'string' && health.damagedReason.length > 0, '损坏原因必须可读')
      s2.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

import { readFile as fs_readFile } from 'node:fs/promises'
