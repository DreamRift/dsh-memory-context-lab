/**
 * T2 隔离提供者测试（beta.35，假 MCP client）。
 *
 * 判据（T2 隔离设计 §3.2–3.3）：
 * - search 合并 T1 + 外部；外部失败只损失外部，T1 分数尺度不变；
 * - read 本地优先；已遗忘/跨会话错误不得被镜像绕过；本地不存在才读隔离根；
 * - mirrorRecord 串行入队、正文含六要素、同 ID、带会话归因；失败只计数；
 * - forgetRecords 把遗忘同步到镜像；close flush 后关闭 client。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createT2IsolatedProvider, mergeHits, mirrorContentOf } from '../src/v3/adapters/retrieval/t2-isolated-provider.mjs'
import { v3Error } from '../src/v3/contracts/index.mjs'
import { T2_SMOKE_NODE_ID } from '../src/v3/contracts/t2.mjs'

const LOCAL_A = 'v3r-aaaaaaaaaaaaaaaa'
const LOCAL_B = 'v3r-bbbbbbbbbbbbbbbb'
const EXTERNAL_ONLY = 'v3r-cccccccccccccccc'

function fakeT1({ search, read } = {}) {
  return {
    async search() {
      return search ?? {
        display: [{ id: LOCAL_A, score: 10 }, { id: LOCAL_B, score: 5 }],
        pack: [{ id: LOCAL_A, score: 10 }],
        dropped: [],
        oovTerms: [],
      }
    },
    async read(id) {
      if (typeof read === 'function') return read(id)
      return { text: '本地正文 ' + id, record: { id, createdAt: 1 } }
    },
    async health() { return { healthy: true, indexedCount: 2 } },
    capabilities() { return { name: 'local-lexical-v3', tier: 'T1' } },
  }
}

function fakeClient({ onCall } = {}) {
  const calls = []
  return {
    calls,
    closed: 0,
    async callTool(name, args) {
      calls.push({ name, args })
      if (typeof onCall === 'function') return await onCall(name, args, calls)
      if (args.op === 'write') return { ok: true, node_id: args.node_id }
      if (args.op === 'forget') return { ok: true }
      if (args.op === 'read' && typeof args.node_id === 'string') {
        return {
          id: args.node_id,
          frontmatter: { created: '2026-10-28T00:00:00Z' },
          content: '隔离正文 ' + args.node_id,
        }
      }
      if (args.op === 'read') {
        return {
          results: [
            { node: { id: LOCAL_A }, score: 0.2 },
            { node: { id: EXTERNAL_ONLY }, score: 0.4 },
            { node: { id: 'not-a-record' }, score: 9 },
          ],
        }
      }
      return { ok: true }
    },
    async close() { this.closed += 1 },
  }
}

function makeProvider({ client = fakeClient(), t1 = fakeT1() } = {}) {
  return {
    provider: createT2IsolatedProvider({ t1, client, sessionKey: 'sess-a', root: 'C:/tmp/t2' }),
    client,
  }
}

test('mergeHits：本地按第一名归一化，外部独有按名次给分，非法 ID 不进结果', () => {
  const local = {
    display: [{ id: LOCAL_A, score: 10 }, { id: LOCAL_B, score: 5 }],
    pack: [{ id: LOCAL_A, score: 10 }],
    oovTerms: [],
  }
  const external = [
    { id: LOCAL_A, score: 0.2 },
    { id: EXTERNAL_ONLY, score: 0.4 },
    { id: 'not-a-record', score: 9 },
  ]
  const merged = mergeHits(local, external, { limit: 10, packMinScore: 0.5 })
  assert.equal(merged.display.length, 3, '非法 ID 必须被过滤')
  const byId = new Map(merged.display.map((hit) => [hit.id, hit]))
  assert.equal(byId.get(LOCAL_A).score, 1)
  assert.equal(byId.get(LOCAL_A).alsoExternal, true)
  assert.equal(byId.get(LOCAL_B).score, 0.5)
  assert.equal(byId.get(EXTERNAL_ONLY).external, true)
  assert.ok(byId.get(EXTERNAL_ONLY).score > 0.5)
  assert.match(merged.sourceLabel, /隔离灵枢/)
})

test('search：T1 与外部融合；外部失败只损失外部（T1 分数不变）', async () => {
  {
    const { provider } = makeProvider()
    const result = await provider.search('查询', { limit: 10, packMinScore: 0.5 })
    assert.equal(result.display.length, 3)
    assert.match(result.sourceLabel, /隔离灵枢/)
  }
  {
    const client = fakeClient({ onCall: async () => { throw new Error('MCP 挂了') } })
    const { provider } = makeProvider({ client })
    const result = await provider.search('查询', { limit: 10, packMinScore: 0.5 })
    assert.deepEqual(result.display.map((hit) => hit.id), [LOCAL_A, LOCAL_B])
    assert.equal(result.display[0].score, 10, '外部失败时不得改动 T1 分数')
    assert.match(result.sourceLabel, /T2 无新增命中/)
  }
})

test('read：本地命中不访问外部；本地不存在才读隔离根', async () => {
  {
    const client = fakeClient()
    const { provider } = makeProvider({ client })
    const result = await provider.read(LOCAL_A)
    assert.match(result.text, /本地正文/)
    assert.equal(client.calls.length, 0)
  }
  {
    const t1 = fakeT1({ read: async (id) => { throw v3Error('ESTORE_CORRUPT', '记录不存在：' + id) } })
    const client = fakeClient()
    const { provider } = makeProvider({ client, t1 })
    const result = await provider.read(EXTERNAL_ONLY)
    assert.match(result.text, /隔离正文/)
    assert.equal(client.calls[0].args.op, 'read')
    assert.equal(client.calls[0].args.node_id, EXTERNAL_ONLY)
    assert.equal(result.record.provenance.sourceForm, 't2-mirror')
  }
})

test('read：已遗忘/跨会话错误必须原样抛出，绝不从镜像复活', async () => {
  for (const code of ['EFORGOTTEN', 'ESTORE_SESSION_MISMATCH']) {
    const t1 = fakeT1({ read: async (id) => { throw v3Error(code, '隐私面拒绝 ' + id) } })
    const client = fakeClient()
    const { provider } = makeProvider({ client, t1 })
    await assert.rejects(() => provider.read(LOCAL_A), (error) => error.code === code)
    assert.equal(client.calls.length, 0, code + ' 时不得访问镜像')
  }
})

test('mirrorRecord：串行写入隔离根，正文含六要素与原文', async () => {
  const client = fakeClient()
  const { provider } = makeProvider({ client })
  provider.mirrorRecord({
    id: LOCAL_A,
    sessionKey: 'sess-a',
    kind: 'message-user',
    payload: { text: '原始正文' },
    provenance: { sourceEventId: 'dsh-1' },
  })
  await provider.flush()
  assert.equal(client.calls.filter((call) => call.args.op === 'write').length, 1)
  const args = client.calls.find((call) => call.args.op === 'write').args
  assert.equal(args.node_id, LOCAL_A)
  assert.equal(args.session, 'sess-a')
  assert.equal(args.content_kind, 'text')
  assert.match(args.content, /^# 功能名：/m)
  assert.match(args.content, /^# 生效条件：/m)
  assert.match(args.content, /^# 子功能：/m)
  assert.match(args.content, /^# 执行：/m)
  assert.match(args.content, /^# 验证方式：/m)
  assert.match(args.content, /^# 不适用条件：/m)
  assert.match(args.content, /原始正文/)
  assert.deepEqual(provider.mirrorStats(), { mirrored: 1, mirrorFailed: 0, mirrorDropped: 0, pending: 0, forgetFailed: 0, lastError: null })
})

test('mirrorRecord：空正文/非法 ID 跳过；外部失败只计数不回滚', async () => {
  const client = fakeClient({ onCall: async (name, args) => { if (args.op === 'write') throw new Error('写入被拒'); return { ok: true } } })
  const { provider } = makeProvider({ client })
  provider.mirrorRecord({ id: LOCAL_A, payload: { text: '' } })
  provider.mirrorRecord({ id: 'bad-id', payload: { text: 'x' } })
  provider.mirrorRecord({ id: LOCAL_B, payload: { text: '会失败' } })
  await provider.flush()
  const stats = provider.mirrorStats()
  assert.equal(stats.mirrorDropped, 2)
  assert.equal(stats.mirrorFailed, 1)
  assert.match(stats.lastError, /写入被拒/)
})

test('forgetRecords：把遗忘同步到镜像；非法 ID 不访问外部', async () => {
  const client = fakeClient()
  const { provider } = makeProvider({ client })
  const result = await provider.forgetRecords([LOCAL_A, 'not-a-record', LOCAL_B])
  assert.equal(result.forgotten, 2)
  assert.equal(client.calls.filter((call) => call.args.op === 'forget').length, 2)
  assert.deepEqual(client.calls.map((call) => call.args.node_id), [LOCAL_A, LOCAL_B])
})

test('先镜像后立刻遗忘：晚到的写被跳过，不把正文写回隔离根', async () => {
  const client = fakeClient()
  const { provider } = makeProvider({ client })
  provider.mirrorRecord({
    id: LOCAL_A,
    sessionKey: 'sess-a',
    kind: 'message-user',
    payload: { text: '刚写入就要遗忘' },
    provenance: {},
  })
  const result = await provider.forgetRecords([LOCAL_A])
  assert.equal(result.forgotten, 1)
  assert.equal(client.calls.filter((call) => call.args.op === 'write').length, 0, '遗忘先标记后，不得再写镜像')
  assert.equal(provider.mirrorStats().mirrorDropped, 1)
})

test('mirrorContentOf：空正文也保持六要素结构（形状函数独立可测）', () => {
  const content = mirrorContentOf({ id: LOCAL_A, sessionKey: 's', kind: 'message-user', payload: {}, provenance: {} })
  assert.equal(content.split('\n').filter((line) => line.startsWith('# ')).length, 6)
})

test('close：先 flush 再关闭 client，幂等', async () => {
  const client = fakeClient()
  const { provider } = makeProvider({ client })
  provider.mirrorRecord({ id: LOCAL_A, sessionKey: 'sess-a', kind: 'message-user', payload: { text: 'x' }, provenance: {} })
  await provider.close()
  await provider.close()
  assert.equal(client.closed, 1)
  assert.equal(client.calls.filter((call) => call.args.op === 'write').length, 1)
})

test('indexStats：复用 T1 索引统计，不额外访问外部；失败如实回状态', async () => {
  {
    const t1 = fakeT1()
    t1.indexStats = async () => ({ state: 'ok', indexedCount: 7, sourceCount: 9, indexStale: false })
    const client = fakeClient()
    const { provider } = makeProvider({ t1, client })
    assert.deepEqual(await provider.indexStats(), { state: 'ok', indexedCount: 7, sourceCount: 9, indexStale: false })
    assert.equal(client.calls.length, 0, '索引统计不得触发外部调用')
  }
  {
    // T1 替身没有 indexStats（旧端口/测试替身）：如实回 unavailable，不伪造数字。
    const { provider } = makeProvider()
    const stats = await provider.indexStats()
    assert.equal(stats.state, 'unavailable')
  }
})

test('cleanupSmoke：按契约 ID 遗忘冒烟节点；失败如实回报并计数', async () => {
  {
    const client = fakeClient()
    const { provider } = makeProvider({ client })
    assert.deepEqual(await provider.cleanupSmoke(), { ok: true, nodeId: T2_SMOKE_NODE_ID })
    const call = client.calls.at(-1)
    assert.equal(call.args.op, 'forget')
    assert.equal(call.args.node_id, T2_SMOKE_NODE_ID)
    assert.equal(call.args.override, true)
  }
  {
    const client = fakeClient({ onCall: async () => { throw new Error('节点不存在') } })
    const { provider } = makeProvider({ client })
    const result = await provider.cleanupSmoke()
    assert.equal(result.ok, false)
    assert.match(result.error, /节点不存在/)
    assert.match(provider.mirrorStats().lastError, /smokeCleanupFailed/)
  }
})

test('health/capabilities：如实报 T2 isolated 与镜像状态', async () => {
  const { provider } = makeProvider()
  const capabilities = provider.capabilities()
  assert.equal(capabilities.tier, 'T2')
  assert.equal(capabilities.isolated, true)
  assert.equal(capabilities.name, 'local-lexical-v3+t2-isolated')
  const health = await provider.health()
  assert.equal(health.healthy, true)
  assert.equal(health.t2.isolated, true)
})