/**
 * v3 T1 提供者与 recall 用例测试（M4 第二批）——真实适配器组合。
 *
 * ## 判据来源
 * retrieval-contract（OOV 不进分母且披露）、recall-gate（纯壳不注入）、
 * N-03（确定性首部切片）、P3（同回合一次）、recall-ptc（read 顶层 text 非空）、
 * P9（索引陈化自动重建）、隐私面（遗忘后 read 失败关闭）。
 *
 * ## 断言组
 * - search：命中排序、OOV 披露、双面门槛、空查询拒绝；
 * - 新增记录后不手工重建 → search 自动重建（P9）；
 * - read：顶层 text 非空；遗忘记录失败关闭；
 * - recall：命中注入（含首部切片与可执行句柄行）；同回合第二次拒；新回合放行；
 *   无命中/纯壳不注入；turn 0 拒。
 *
 * ## 不适用条件与已知边界
 * exact 短语顺序（多条件 AND）在 M4 合并通道扩展时补；T2（dsh-memory）属 M5。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { sliceByChars } from '../src/v3/application/recall.mjs'
import { createRecall, RECALL_PACK_MAX_CHARS, isExactRecordId } from '../src/v3/application/recall.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

const SESSION_KEY = 'sess-a'

function record(id, text) {
  return {
    id,
    kind: 'operation',
    sessionKey: SESSION_KEY,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + id, sourceForm: 'tool/result', transactionId: 'tx-' + id },
  }
}

async function withStack(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-t1-'))
  const { port, store } = await createSessionStorePort(root, SESSION_KEY)
  const metrics = { counters: new Map(), counter(n, v) { this.counters.set(n, (this.counters.get(n) ?? 0) + v) }, observe() {} }
  try {
    const provider = createT1Provider({ port, store, metrics })
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_KEY })
    return await body({ provider, recall, port, store, metrics })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('查询覆盖门槛：靠单个高频低质词攒分的垃圾命中被拒（2026-10-25 拍板）', async () => {
  await withStack(async ({ provider, port }) => {
    // 长文里「面板/方面」等含「面」「机」高频，但对「揉面机面粉」只命中 2/9 词
    await port.transaction([
      record('v3r-0123456789abc100', '设置面板上面的层级压缩开关与读取租约的机器用法说明'.repeat(3)),
      record('v3r-0123456789abc101', '揉面机面粉配比的心得记录'),
    ])
    const oovLike = await provider.search('揉面机面粉 配比')
    // 目标文档命中大多数查询词；垃圾文档只命中零星单字 → 不进 display
    assert.ok(oovLike.display.some((d) => d.id === 'v3r-0123456789abc101'), '真相关文档在')
    assert.ok(!oovLike.display.some((d) => d.id === 'v3r-0123456789abc100'), '低覆盖垃圾命中被拒')
    // 单词/双词查询不被误伤：至少命中 1 词即过
    const narrow = await provider.search('层级')
    assert.ok(narrow.display.length >= 1, '窄查询不受覆盖门槛误伤')
  })
})

test('search：命中、OOV 披露、双面门槛、空查询拒绝', async () => {
  await withStack(async ({ provider, port }) => {
    await port.transaction([
      record('v3r-0123456789abc000', '记忆插件的开发计划与测试'),
      record('v3r-0123456789abc001', '检索引擎的排序与预算'),
    ])
    const hit = await provider.search('记忆 开发')
    assert.ok(hit.display.length >= 1)
    assert.equal(hit.display[0].id, 'v3r-0123456789abc000')
    const withOov = await provider.search('记忆 qqxxzz')
    assert.ok(withOov.oovTerms.includes('qqxxzz'), 'OOV 词单独披露')
    assert.ok(withOov.display.length >= 1, 'OOV 不进分母：相关结果不被稀释到零')
    const gated = await provider.search('记忆', { resultMinScore: 0.01, packMinScore: 999 })
    assert.ok(gated.display.length >= 1 && gated.pack.length === 0, '双面门槛分离')
    await assert.rejects(() => provider.search(''), (e) => e?.name === 'V3ContractViolation')
  })
})

test('P9：索引文件丢失（派生物可删除），search 自动重建可见', async () => {
  await withStack(async ({ provider, port, metrics, store }) => {
    await port.transaction([record('v3r-0123456789abc000', '首批正文')])
    await provider.search('首批') // 触发首次索引
    // 写点已随事务重建索引（M3 口径），所以这里模拟「派生物被删」：直接删索引文件
    await rm(path.join(store.directory, 'lexical-index.json'), { force: true })
    const later = await provider.search('首批')
    assert.ok(later.display.some((d) => d.id === 'v3r-0123456789abc000'), '索引被删也能检到')
    assert.equal((await provider.health()).indexStale, false)
    assert.ok(metrics.counters.get('v3.t1.indexRebuilt') >= 1, '兜底重建有计量')
  })
})

test('read：顶层 text 非空；遗忘记录失败关闭', async () => {
  await withStack(async ({ provider, port }) => {
    await port.transaction([record('v3r-0123456789abc000', '可回读正文')])
    const read = await provider.read('v3r-0123456789abc000')
    assert.equal(read.text, '可回读正文')
    assert.equal(typeof read.text, 'string')
    await port.forget(['v3r-0123456789abc000'])
    await assert.rejects(() => provider.read('v3r-0123456789abc000'), (e) => e.code === 'EFORGOTTEN' || e.code === 'ESTORE_CORRUPT')
  })
})

test('recall：注入（首部切片+可执行句柄）；同回合拒、新回合放行', async () => {
  await withStack(async ({ recall, port }) => {
    await port.transaction([record('v3r-0123456789abc000', '这是一段足够长的正文用于验证首部切片行为，'.repeat(12))])
    const first = await recall({ query: '正文 切片', turn: 1 })
    assert.equal(first.injected, true)
    assert.ok(first.text.includes('回注包（命中 1 条'))
    assert.ok(first.text.includes('首部：'))
    assert.ok(first.text.includes('memory_lab_recall(record_ids='))
    assert.ok(first.text.length < 800, '回注包有界')
    const again = await recall({ query: '正文 切片', turn: 1 })
    assert.equal(again.injected, false)
    assert.match(again.reason, /只出现一步/)
    const nextTurn = await recall({ query: '正文 切片', turn: 2 })
    assert.equal(nextTurn.injected, true)
  })
})

test('sliceByChars：代理对边界不被切断（码点纪律）', () => {
  const emoji = '😀'.repeat(200)
  const sliced = sliceByChars(emoji, 160)
  assert.equal([...sliced].length, 160)
  const last = sliced.charCodeAt(sliced.length - 1)
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), '末单元不得是孤立高位代理（半个代理对）')
})

test('recall：无命中与纯壳不注入；turn 0 拒', async () => {
  await withStack(async ({ recall, port }) => {
    await port.transaction([record('v3r-0123456789abc000', '记忆插件正文')])
    const none = await recall({ query: '毫不相关词组', turn: 1 })
    assert.equal(none.injected, false)
    assert.equal(none.reason, '无命中')
    const weak = await recall({ query: '记忆', turn: 1, packMinScore: 999 })
    assert.equal(weak.injected, false)
    assert.match(weak.reason, /纯壳不注入/)
    await assert.rejects(() => recall({ query: '记忆', turn: 0 }), (e) => e?.name === 'V3ContractViolation')
  })
})

test('⑤ 注入上界（P0-4）：超大装包保完整行截断、省略可见（2026-10-25 用户拍板移植）', async () => {
  await withStack(async ({ port, store, metrics, provider }) => {
    // 40 条长文——总回注必然超过 4000 字符硬顶
    for (let i = 0; i < 40; i += 1) {
      await port.transaction([record('v3r-' + String(i).padStart(16, '0'), '长文' + i + '：' + '数据'.repeat(120))])
    }
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_KEY })
    // 40 条同质文档会把 BM25 归一得分摊薄（实测 top≈0.117）——显式降低装包阈，测的是上界不是阈
    const r = await recall({ query: '长文 数据', turn: 1, limit: 40, packMinScore: 0.05 })
    assert.ok(r.injected)
    assert.ok(r.text.length <= RECALL_PACK_MAX_CHARS + 200, '回注包不超硬顶+收尾行：' + r.text.length)
    assert.match(r.text, /注入上界：超出/, '省略必须可见')
    assert.equal(metrics.counters.get('v3.recall.pack-truncated'), 1)
  })
})

test('⑨ 别名解析：非精确 ID 经 resolveAlias 回读；未实现/未命中失败关闭', async () => {
  assert.equal(isExactRecordId('v3r-0000000000000000'), true)
  assert.equal(isExactRecordId('call_abc'), false)
  await withStack(async ({ provider, port }) => {
    await port.transaction([record('v3r-0000000000000000', '正文一')])
    const metrics = { counter() {}, observe() {} }
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_KEY })
    // 端口未实现 resolveAlias → 失败关闭（不猜）
    await assert.rejects(() => recall.readByRef('call_abc'), /resolveAlias/)
    // 实现 resolveAlias 后：别名命中回读原文；未命中显式拒
    provider.resolveAlias = async (alias) => (alias === 'call_abc' ? 'v3r-0000000000000000' : null)
    const read = await recall.readByRef('call_abc')
    assert.equal(read.text, '正文一')
    await assert.rejects(() => recall.readByRef('call_missing'), /别名未命中/)
  })
})
