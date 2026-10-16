/**
 * 复合检索后端提供者（PR #3）的诚实边界守卫（D1，0.9.0-rc.6）：
 *
 * describe() 的顶层 name/capabilities 必须报「当前实际生效」的后端。灵枢 root
 * 在场（available）不等于已为会话启动（sessions>0）——backendFor 只在灵枢为
 * 该会话启动过时才返回 T2。用 available 当判据会在未启动时把灵枢报成生效
 * 后端（状态面虚报）。这里用最小 stub 驱动真实提供者，任何口径回退都会红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCompositeRetrievalBackendProvider } from '../src/v2/retrieval-backend-provider.mjs'
import { LOCAL_LEXICAL_BACKEND_NAME } from '../src/v2/local-lexical-backend.mjs'

const LINGSHU_NAME = 'ling-shu-t2-stub'
const LINGSHU_CAPS = { lexical: true, structural: true }

function stubLingshu({ sessions = 0, backend = null, ensure = null } = {}) {
  return {
    describe() {
      return { available: true, name: LINGSHU_NAME, capabilities: LINGSHU_CAPS, sessions }
    },
    backendFor() {
      return backend
    },
    async ensureBackend() {
      return ensure ?? { ok: true, backend: backend ?? {}, reason: null }
    },
    failureReason() {
      return null
    },
    async close() {},
    async closeAll() {},
  }
}

test('describe reports the local backend while lingshu has no active session (D1)', () => {
  // 灵枢 available=true（root 在场）但 sessions=0：实际生效的是本地词法后端。
  const provider = createCompositeRetrievalBackendProvider({ lingshu: stubLingshu({ sessions: 0 }) })
  const described = provider.describe()
  assert.equal(described.name, LOCAL_LEXICAL_BACKEND_NAME, 'name must report the backend that is actually in effect')
  assert.deepEqual(described.capabilities, described.local.capabilities, 'capabilities must match the effective backend')
})

test('describe reports lingshu once it has an active session (D1)', () => {
  const provider = createCompositeRetrievalBackendProvider({ lingshu: stubLingshu({ sessions: 1 }) })
  const described = provider.describe()
  assert.equal(described.name, LINGSHU_NAME)
  assert.deepEqual(described.capabilities, LINGSHU_CAPS)
})

test('backendFor falls back to the local backend when lingshu returns nothing', () => {
  const provider = createCompositeRetrievalBackendProvider({ lingshu: stubLingshu({ backend: null }) })
  const backend = provider.backendFor({ sessionId: 's1', storeRoot: 'D:\\tmp\\store' })
  assert.ok(backend, 'the local backend must be created lazily')
  assert.equal(provider.describe().local.sessions, 1, 'the local entry must be visible in the status surface')
})

test('ensureBackend degrades honestly with the lingshu failure reason', async () => {
  const provider = createCompositeRetrievalBackendProvider({
    lingshu: stubLingshu({ ensure: { ok: false, reason: 'tools/list 握手失败' } }),
  })
  const outcome = await provider.ensureBackend({ sessionId: 's2', storeRoot: 'D:\\tmp\\store' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, 'tools/list 握手失败')
  assert.equal(outcome.fallback, LOCAL_LEXICAL_BACKEND_NAME)
})

test('close releases the local entry but not lingshu sessions', async () => {
  const provider = createCompositeRetrievalBackendProvider({ lingshu: stubLingshu({ sessions: 1 }) })
  provider.backendFor({ sessionId: 's3', storeRoot: 'D:\\tmp\\store' })
  await provider.close('s3')
  const described = provider.describe()
  assert.equal(described.local.sessions, 0, 'the closed session must leave the local map')
  assert.equal(described.name, LINGSHU_NAME, 'the still-active lingshu session keeps the top-level name')
})

// ── 显式指定（PR #4 端口二，retrievalBackend 配置）─────────────────────────

test('forced lingshu with no lingshu present: precheck fails closed with EBACKENDUNAVAILABLE', () => {
  const provider = createCompositeRetrievalBackendProvider({ lingshu: null, forcedMode: 'lingshu-mdcg-receipt' })
  const pre = provider.precheck()
  assert.equal(pre.ok, false)
  assert.equal(pre.code, 'EBACKENDUNAVAILABLE')
  // 未启动期检索失败关闭：不隐式起 T1 兜底。
  assert.equal(provider.backendFor({ sessionId: 's4', storeRoot: 'D:\\tmp\\store' }), null)
})

test('forced lingshu with lingshu present: precheck passes; handshake failure is EBACKENDPINGFAIL, no fallback', async () => {
  const provider = createCompositeRetrievalBackendProvider({
    lingshu: stubLingshu({ ensure: { ok: false, reason: 'tools/list 握手失败' } }),
    forcedMode: 'lingshu-mdcg-receipt',
  })
  assert.equal(provider.precheck().ok, true)
  const outcome = await provider.ensureBackend({ sessionId: 's5', storeRoot: 'D:\\tmp\\store' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'EBACKENDPINGFAIL')
  assert.ok(outcome.reason.includes('握手失败'), 'the lingshu failure reason must be carried through verbatim')
})

test('forced local-lexical-v1: never tries T2, describe marks the forced mode', async () => {
  let ensureCalls = 0
  const provider = createCompositeRetrievalBackendProvider({
    lingshu: {
      ...stubLingshu(),
      async ensureBackend() { ensureCalls += 1; return { ok: true, backend: {} } },
    },
    forcedMode: 'local-lexical-v1',
  })
  const outcome = await provider.ensureBackend({ sessionId: 's6', storeRoot: 'D:\\tmp\\store' })
  assert.equal(ensureCalls, 0, 'the forced local mode must not attempt T2')
  assert.equal(outcome.ok, true)
  assert.equal(provider.describe().forcedMode, 'local-lexical-v1')
  assert.equal(provider.precheck().ok, true)
})

test('auto mode keeps the existing degradation semantics (guard against regressions)', async () => {
  const provider = createCompositeRetrievalBackendProvider({
    lingshu: stubLingshu({ ensure: { ok: false, reason: 'root 不在场' } }),
  })
  const outcome = await provider.ensureBackend({ sessionId: 's7', storeRoot: 'D:\\tmp\\store' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.fallback, LOCAL_LEXICAL_BACKEND_NAME)
  assert.equal(provider.precheck().ok, true, 'auto must not fail the precheck even when lingshu is absent')
})

test('P1-5 探测一次固定：同会话重复 ensure 不再重握手，close 后重新探测', async () => {
  let ensureCalls = 0
  const lingshuStub = {
    describe: () => ({ name: 'lingshu-mdcg-receipt', sessions: 0 }),
    backendFor: () => null,
    failureReason: () => null,
    async ensureBackend() { ensureCalls += 1; return { ok: false, reason: '瞬断' } },
    async close() {},
  }
  const provider = createCompositeRetrievalBackendProvider({ lingshu: lingshuStub })
  const first = await provider.ensureBackend({ sessionId: 's8', storeRoot: 'D:\tmp\store' })
  const second = await provider.ensureBackend({ sessionId: 's8', storeRoot: 'D:\tmp\store' })
  assert.equal(ensureCalls, 1, '同一会话第二次 ensure 不重复探测（缓存命中）')
  assert.equal(first.ok, true)
  assert.equal(second.fallback, LOCAL_LEXICAL_BACKEND_NAME)
  await provider.close('s8')
  await provider.ensureBackend({ sessionId: 's8', storeRoot: 'D:\tmp\store' })
  assert.equal(ensureCalls, 2, 'close 清除缓存后允许重新探测')
})

test('P1-5 forced 模式同样缓存失败：重复 ensure 不反复握手', async () => {
  let ensureCalls = 0
  const lingshuStub = {
    describe: () => ({ name: 'lingshu-mdcg-receipt', sessions: 0 }),
    backendFor: () => null,
    failureReason: () => null,
    async ensureBackend() { ensureCalls += 1; return { ok: false, reason: '握手失败' } },
    async close() {},
  }
  const provider = createCompositeRetrievalBackendProvider({ lingshu: lingshuStub, forcedMode: 'lingshu-mdcg-receipt' })
  const forced = await provider.ensureBackend({ sessionId: 's9', storeRoot: 'D:\tmp\store' })
  await provider.ensureBackend({ sessionId: 's9', storeRoot: 'D:\tmp\store' })
  assert.equal(ensureCalls, 1)
  assert.equal(forced.ok, false)
  assert.equal(forced.code, 'EBACKENDPINGFAIL')
})
