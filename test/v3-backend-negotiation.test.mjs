/**
 * v3 后端协商测试（M5 尾批）。
 *
 * ## 判据来源
 * D3（能力协商失败关闭）、retrieval-provider D1（报实际生效不是期望）、
 * capabilities 合同（版本未实测→回 T1 是设计而非缺陷）。
 *
 * ## 断言组
 * - 无探测 → T1 + fail-closed reason；
 * - 探测非 dsh-memory / 缺工具 / 冒烟未过 / 版本未实测 → T1（合同语义逐条）；
 * - TESTED 清单为空的当前态：即使探测全绿也回 T1（设计而非缺陷）；
 * - T2 工厂缺位/抛错 → 如实回落 T1 且 reason 说明（不静默）。
 *
 * ## 不适用条件与已知边界
 * 真实 dsh-memory 探测（版本/工具/冒烟）在 M6 真机执行后登记 TESTED 清单。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { negotiateMemoryBackend } from '../src/v3/adapters/retrieval/backend-negotiation.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { TESTED_DSH_MEMORY_VERSIONS } from '../src/v3/contracts/capabilities.mjs'

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

const FULL = {
  name: '@furongjun1999/dsh-memory',
  version: '0.9.12',
  tools: ['memory_store', 'memory_search', 'memory_read'],
  smokePassed: true,
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

test('TESTED 清单为空的当前态：探测全绿也回 T1（设计而非缺陷）', async () => {
  await withBackend(async ({ port, store }) => {
    assert.equal(TESTED_DSH_MEMORY_VERSIONS.length, 0, '前置：清单为空（M6 实测后才登记）')
    const { decision } = await negotiateMemoryBackend({ port, store, probe: async () => FULL })
    assert.equal(decision.tier, 'T1')
    assert.match(decision.reason, /版本未实测/)
  })
})

test('T2 分支当前不可达（TESTED 为空）——工厂回落语义待 M6 登记后覆盖', async () => {
  await withBackend(async ({ port, store }) => {
    // T2 选中前提是版本进 TESTED 清单（M6 实测登记）；当前清单为空，
    // 任何探测都回 T1——工厂缺位/抛错的回落分支因此暂不可达。
    // 这里锁住可达性前提，防止清单被预先填上（禁止预先登记）：
    assert.equal(TESTED_DSH_MEMORY_VERSIONS.length, 0)
    const { decision, provider } = await negotiateMemoryBackend({
      port, store,
      probe: async () => ({ ...FULL }),
      t2ProviderFactory: async () => { throw new Error('不应被调用：T1 时代 T2 工厂必须缺席') },
    })
    assert.equal(decision.tier, 'T1')
    assert.equal(typeof provider.search, 'function')
  })
})
