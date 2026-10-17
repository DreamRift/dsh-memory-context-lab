/**
 * 灵枢检索后端：真实实现的行为与诚实边界。
 *
 * 这里用**假客户端**测行为契约（索引正文真的带正文、命中真的映射成记录 ID、
 * 写失败如实上报）；真实隔离灵枢的集成测试在 `v2-lingshu-integration.test.mjs`，
 * 两者不互相冒充。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINGSHU_BACKEND_CAPABILITIES,
  createLingshuBackendProvider,
  createLingshuSemanticBackend,
  indexBodyOf,
  recordIdsFromRecall,
} from '../src/v2/lingshu-backend.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'

function recordFixture({ id = 't00000001-r0000', text = '正文里有唯一词 needle-42', kind = RECORD_KINDS.ASSISTANT_TEXT } = {}) {
  return {
    id,
    kind,
    fidelity: 'verbatim',
    seq: 3,
    refs: { spanKind: 'assistant-text' },
    inline: { nodeId: 'n-1', tools: ['read'] },
    text,
    textIntegrity: 'ok',
  }
}

test('索引正文必须带真实正文摘录，不能只送元数据', () => {
  const body = indexBodyOf(recordFixture())
  assert.match(body, /needle-42/, '索引正文必须含真实正文，否则检索永远搜不到库里存在的词')
  assert.match(body, /记录 t00000001-r0000/, '索引正文必须带权威记录 ID，命中才能回源')
  assert.match(body, /kind=assistant\.text/)
})

test('截断摘录必须显式标注「非全文」，不把前缀当全文', () => {
  const body = indexBodyOf({ ...recordFixture(), textTruncated: true, textMaxBytes: 256 })
  assert.match(body, /非全文/)
  assert.match(body, /按记录 ID 回读/)
})

test('命中形状：只认 node.id / id，形状不认识就抛，不静默当成「没有命中」', () => {
  assert.deepEqual(
    recordIdsFromRecall({ results: [{ node: { id: 't00000001-r0000' } }, { id: 't00000001-r0001' }] }),
    ['t00000001-r0000', 't00000001-r0001'],
  )
  assert.throws(() => recordIdsFromRecall({ meta: { reason: 'no_candidates' } }), /缺少 results/)
  assert.throws(() => recordIdsFromRecall(null), /非对象/)
})

test('后端自称不含向量语义检索，状态面照抄不夸大', () => {  assert.equal(LINGSHU_BACKEND_CAPABILITIES.semanticVectors, false)
  assert.equal(LINGSHU_BACKEND_CAPABILITIES.kind, 'lexical-structural')
})

test('索引写入：条数参数是 k 不是 limit，且必须带 receipt 视图', async () => {
  const calls = []
  const backend = createLingshuSemanticBackend({
    client: {
      sessionId: 'sess-1',
      async callTool(name, params) {
        calls.push({ name, params })
        if (name === 'cg') return { results: [] }
        return { ok: true }
      },
    },
  })
  await backend.index([recordFixture()])
  await backend.query('needle-42', { limit: 7 })

  const remember = calls.find((call) => call.name === 'mdcg_remember')
  assert.equal(remember.params.node_id, 't00000001-r0000', '灵枢节点 ID 直接复用权威记录 ID，天然幂等')
  assert.equal(remember.params.role, 'tool-output')
  assert.equal(remember.params.layer, 'contextual')
  assert.equal(remember.params.gated, false, '派生索引不进门禁')

  const query = calls.find((call) => call.name === 'cg')
  assert.equal(query.params.k, 7, '条数参数是 k；写成 limit 会静默失效')
  assert.ok(query.params.view, '不带 receipt 视图会让 role:tool-output 整类被剔除，永远搜不到')
  assert.equal(query.params.limit, undefined)
})

test('没有正文的记录不进索引：记账不得把它当「已索引」', async () => {
  const backend = createLingshuSemanticBackend({
    client: { sessionId: 's', async callTool() { return { ok: true } } },
  })
  const result = await backend.index([recordFixture({ id: 't00000001-r0000', text: '' })])
  assert.equal(Object.keys(result.externalIds).length, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /text-/)
})

test('单条写失败如实进 conflicts，不连坐整批也不假装成功', async () => {
  const backend = createLingshuSemanticBackend({
    client: {
      sessionId: 's',
      async callTool(name, params) {
        if (name === 'mdcg_remember' && params.node_id.endsWith('r0001')) return { ok: false, error: 'EBOOM' }
        return { ok: true }
      },
    },
  })
  const result = await backend.index([
    recordFixture({ id: 't00000001-r0000' }),
    recordFixture({ id: 't00000001-r0001' }),
  ])
  assert.deepEqual(Object.keys(result.externalIds), ['t00000001-r0000'])
  assert.equal(result.conflicts.length, 1)
  assert.match(result.conflicts[0].reason, /EBOOM/)
})

test('同 ID 不同正文被灵枢排入复核队列时，回读不符必须报错而不是当成功', async () => {
  const backend = createLingshuSemanticBackend({
    client: {
      sessionId: 's',
      async callTool(name) {
        if (name === 'mdcg_remember') return { ok: true, committed: false }
        return { ok: true }
      },
      async getNode() {
        // 真实契约（normalizeNodeRead）返回 content，不是 text。
        return { ok: true, content: '完全不同的旧正文' }
      },
    },
  })
  // 单条冲突不连坐整批，但必须如实进 conflicts —— 调用方据此**不**把它记为已索引。
  const result = await backend.index([recordFixture()])
  assert.deepEqual(Object.keys(result.externalIds), [], '回读不符的记录绝不能被记成已索引')
  assert.equal(result.conflicts.length, 1)
  assert.match(result.conflicts[0].reason, /回读不符/)
})

test('同 ID 且回读内容一致时视为幂等重写成功', async () => {
  const backend = createLingshuSemanticBackend({
    client: {
      sessionId: 's',
      async callTool() { return { ok: true, committed: false } },
      async getNode(id) { return { ok: true, content: `[v2 派生索引] 记录 ${id} ...` } },
    },
  })
  const result = await backend.index([recordFixture()])
  assert.deepEqual(Object.keys(result.externalIds), ['t00000001-r0000'])
  assert.equal(result.conflicts.length, 0)
})

test('provider：未定位到 dsh-memory 时如实报不可用，且绝不回退正式根', async () => {
  const provider = createLingshuBackendProvider({ lingshuPackageRoot: '' })
  assert.equal(provider.describe().available, false)
  assert.match(provider.describe().reason, /不会回退到正式灵枢根/)
  assert.equal(provider.backendFor({ sessionId: 's', storeRoot: '/tmp/x' }), null)
  const started = await provider.ensureBackend({ sessionId: 's', storeRoot: '/tmp/x' })
  assert.equal(started.ok, false)
  assert.match(started.reason, /不会回退到正式灵枢根/)
})

test('provider：取用是同步零副作用，只有 ensureBackend 才真的启动', async () => {
  let created = 0
  const provider = createLingshuBackendProvider({
    lingshuPackageRoot: '/fake/dsh-memory',
    createClient: async () => {
      created += 1
      return { sessionId: 'sess-1', async callTool() { return { results: [] } }, async close() {} }
    },
  })
  // 只读取用不启动子进程：热路径上每次检索都 spawn 是灾难。
  assert.equal(provider.backendFor({ sessionId: 'sess-1', storeRoot: '/tmp/x' }), null)
  assert.equal(created, 0, 'backendFor 不得触发启动')

  const started = await provider.ensureBackend({ sessionId: 'sess-1', storeRoot: '/tmp/x' })
  assert.equal(started.ok, true)
  assert.equal(created, 1)

  // 启动后同步取用拿得到同一个后端，且不重复启动。
  assert.equal(provider.backendFor({ sessionId: 'sess-1', storeRoot: '/tmp/x' }), started.backend)
  assert.equal(created, 1)

  await provider.close('sess-1')
  assert.equal(provider.backendFor({ sessionId: 'sess-1', storeRoot: '/tmp/x' }), null)
  // 取用是纯查询：不给没启动过的会话留下任何条目，否则长期运行会无界增长。
  provider.backendFor({ sessionId: 'sess-never-started', storeRoot: '/tmp/w' })
  assert.equal(provider.describe().sessions, 0)
})

test('provider：启动失败记住原因，不每次检索都重试 spawn', async () => {
  let attempts = 0
  const provider = createLingshuBackendProvider({
    lingshuPackageRoot: '/fake/dsh-memory',
    createClient: async () => {
      attempts += 1
      throw new Error('python 起不来')
    },
  })
  const first = await provider.ensureBackend({ sessionId: 'sess-2', storeRoot: '/tmp/y' })
  assert.equal(first.ok, false)
  assert.match(first.reason, /python 起不来/)
  assert.equal(provider.failureReason('sess-2'), 'python 起不来')
  assert.equal(provider.backendFor({ sessionId: 'sess-2', storeRoot: '/tmp/y' }), null)

  // 失败后不再自动重试：取用路径必须是零副作用的。
  provider.backendFor({ sessionId: 'sess-2', storeRoot: '/tmp/y' })
  assert.equal(attempts, 1)
})

test('provider：并发 ensure 只启动一次（共享同一个 starting promise）', async () => {
  let attempts = 0
  const provider = createLingshuBackendProvider({
    lingshuPackageRoot: '/fake/dsh-memory',
    createClient: async () => {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { sessionId: 's', async callTool() { return { results: [] } }, async close() {} }
    },
  })
  const [a, b, c] = await Promise.all([
    provider.ensureBackend({ sessionId: 'sess-3', storeRoot: '/tmp/z' }),
    provider.ensureBackend({ sessionId: 'sess-3', storeRoot: '/tmp/z' }),
    provider.ensureBackend({ sessionId: 'sess-3', storeRoot: '/tmp/z' }),
  ])
  assert.equal(attempts, 1, '同一会话并发启动只能起一个子进程')
  assert.equal(a.backend, b.backend)
  assert.equal(b.backend, c.backend)
})
