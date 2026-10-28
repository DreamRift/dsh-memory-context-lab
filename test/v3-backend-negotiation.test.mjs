/**
 * v3 后端协商测试（M5 尾批 + beta.35 隔离 T2）。
 *
 * ## 判据来源
 * D3（能力协商失败关闭）、retrieval-provider D1（报实际生效不是期望）、
 * capabilities 合同（版本未实测→回 T1 是设计而非缺陷）。
 *
 * ## 断言组
 * - 无探测 → T1 + fail-closed reason；
 * - 探测非 dsh-memory / 缺工具 / 冒烟未过 / 版本未实测 → T1（合同语义逐条）；
 * - 探测抛错 → T1（**不得炸装配**：一次 Python 启动失败不能让整个会话建库失败）；
 * - T2 被选中且工厂存在 → 返回 T2 provider；工厂缺位/抛错 → 如实回落 T1 且 reason 说明；
 * - 探测携带的 handle 只在 T2 工厂接管时保留，其余路径必须关闭（不泄漏子进程）。
 *
 * ## 不适用条件与已知边界
 * 本套件用替身验证装配语义；真实 MCP 握手/冒烟由 `scripts/t2-smoke.mjs` 与
 * `v3-t2-*.test.mjs` 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { negotiateMemoryBackend } from '../src/v3/adapters/retrieval/backend-negotiation.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

async function withBackend(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-be-'))
  const { port, store } = await createSessionStorePort(root, 'sess-a')
  try {
    return await body({ port, store })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const TESTED_VERSION = '0.9.10'
const FULL = {
  name: '@furongjun1999/dsh-memory',
  version: TESTED_VERSION,
  tools: ['memory_store', 'memory_search', 'memory_read'],
  smokePassed: true,
}

function handleSpy() {
  return {
    closed: 0,
    async close() { this.closed += 1 },
  }
}

test('无探测 → T1 fail-closed', async () => {
  await withBackend(async ({ port, store }) => {
    const { provider, decision } = await negotiateMemoryBackend({ port, store })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /fail-closed/)
    assert.equal(typeof provider.search, 'function')
  })
})

test('探测各失败分支 → T1（合同语义逐条）', async () => {
  await withBackend(async ({ port, store }) => {
    const cases = [
      [{ ...FULL, name: 'other-pkg' }, /非 dsh-memory/],
      [{ ...FULL, tools: ['memory_store'] }, /缺必需工具/],
      [{ ...FULL, smokePassed: false }, /冒烟/],
      [{ ...FULL, version: '' }, /版本未知/],
      [{ ...FULL, version: '0.0.1-not-tested' }, /版本未实测/],
    ]
    for (const [described, pattern] of cases) {
      const { decision } = await negotiateMemoryBackend({ port, store, probe: async () => described })
      assert.equal(decision.tier, 'T1', JSON.stringify(described))
      assert.match(decision.reason, pattern)
    }
  })
})

test('探测抛错 → T1（不炸装配，reason 带原始错误）', async () => {
  await withBackend(async ({ port, store }) => {
    const { provider, decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => { throw new Error('python 不存在') },
    })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /探测抛错回落 T1/)
    assert.match(decision.reason, /python 不存在/)
    assert.equal(typeof provider.search, 'function')
  })
})

test('T2 被选中：工厂拿到 t1 与探测结果，返回 T2 provider', async () => {
  await withBackend(async ({ port, store }) => {
    const t2 = { marker: 't2-provider' }
    let received = null
    const { provider, decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({ ...FULL }),
      t2ProviderFactory: async (described, deps) => {
        received = { described, deps }
        return t2
      },
    })
    assert.equal(decision.tier, 'T2')
    assert.equal(provider, t2)
    assert.equal(received.described.version, TESTED_VERSION)
    assert.equal(typeof received.deps.t1.search, 'function')
  })
})

test('T2 工厂缺位 → 如实回落 T1 并关闭探测句柄', async () => {
  await withBackend(async ({ port, store }) => {
    const handle = handleSpy()
    const { provider, decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({ ...FULL, handle }),
    })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /工厂缺位/)
    assert.equal(handle.closed, 1)
    assert.equal(typeof provider.search, 'function')
  })
})

test('T2 工厂抛错 → 回落 T1 且关闭探测句柄（不泄漏子进程）', async () => {
  await withBackend(async ({ port, store }) => {
    const handle = handleSpy()
    const { decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({ ...FULL, handle }),
      t2ProviderFactory: async () => { throw new Error('工厂坏了') },
    })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /T2 工厂失败回落 T1/)
    assert.equal(handle.closed, 1)
  })
})

test('T1 裁决也关闭探测句柄：版本未实测时不得留着已启动的 Python', async () => {
  await withBackend(async ({ port, store }) => {
    const handle = handleSpy()
    const { decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({ ...FULL, version: '0.0.1', handle }),
    })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /版本未实测/)
    assert.equal(handle.closed, 1)
  })
})

test('隔离探测：cg 工具面 + isolated=true 升 T2 isolated', async () => {
  await withBackend(async ({ port, store }) => {
    const { decision } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({
        name: '@furongjun1999/dsh-memory',
        version: TESTED_VERSION,
        tools: ['cg', 'stg'],
        smokePassed: true,
        isolated: true,
        root: '/tmp/session/t2-mdcg',
      }),
      t2ProviderFactory: async () => ({ marker: 'isolated' }),
    })
    assert.equal(decision.tier, 'T2')
    assert.equal(decision.provider, 'dsh-memory-isolated')
  })
})