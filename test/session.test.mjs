/**
 * 共享降温管线的纯逻辑测试（0.13.1）。
 *
 * 0.13.1 删除了 v1 引擎，原先通过 `/memory-lab on|off|status` 驱动的 37 个
 * v1 生命周期用例随之删除——它们断言的是 v1 账本、v1 清理语义与 v1 命令面，
 * 而这些对象已不存在。v2 生命周期的等价覆盖在 `v2-runtime.test.mjs` /
 * `v2-e2e.test.mjs` / `v2-authoritative-ledger.test.mjs` 里。
 *
 * 本文件保留的是**引擎无关**的纯逻辑断言：ordinal 分配器与节点声明账本。
 * 这些不变量对 v2 同样成立，且与命令面无关，所以迁移而非删除。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { claimsOfRecord, makeOrdinalAllocator, nodeClaimOf } from '../src/apply-engine.mjs'

test('the ordinal allocator never reissues a claimed or applied id', () => {
  const record = { state: { nodeClaims: { 20: { ordinal: 3 }, 40: { ordinal: 2 } }, archive: [{ nodeId: 'archived_key_7' }] } }
  const allocator = makeOrdinalAllocator(record)
  assert.equal(allocator.next(), 8, 'one past the highest of claims and receipts')
  assert.equal(allocator.next(), 9)
})

test('nodeClaimOf returns the durable claim for a range', () => {
  const record = { state: { nodeClaims: { 20: { ordinal: 3 } } } }
  assert.deepEqual(nodeClaimOf(record, 20), { ordinal: 3 })
  assert.equal(nodeClaimOf(record, 21), null)
  // A state from an older build has no claims at all.
  assert.equal(nodeClaimOf({ state: {} }, 1), null)
})

test('claimsOfRecord initializes an empty claim map in place', () => {
  const state = {}
  const claims = claimsOfRecord({ state })
  assert.deepEqual(claims, {})
  claims[1] = { ordinal: 1 }
  assert.equal(state.nodeClaims[1].ordinal, 1, 'the map must be the state object, not a copy')
})

// The e943ef19 deadlock, replayed at the allocator level: a failed unit leaves
// an orphaned write behind under its claimed node id, and the claim is then
// deleted so the next measure re-mints. The allocator must look at the durable
// failure ledger, not just the live claims, or it hands the same poisoned id
// straight back and the unit collides with its own orphan forever.
test('the ordinal allocator skips ids named in the failure ledger', () => {
  const record = {
    state: {
      nodeClaims: { 20: { ordinal: 3 } },
      archive: [{ nodeId: 'archived_key_7', chunkIds: ['archived_key_7_p1'] }],
      lastFailures: [
        { rangeStart: 10, nodeId: 'archived_key_1', state: 'cold-write-failed' },
        { rangeStart: 12, nodeId: 'archived_key_4', state: 'orphaned' },
      ],
    },
  }
  const allocator = makeOrdinalAllocator(record)
  // Claims hold 3, the receipt holds 7, the orphans hold 1 and 4 → max is 7.
  assert.equal(allocator.next(), 8, 'one past claims, receipts, and orphaned writes alike')
})

test('a poisoned claim can be deleted so the next measure re-mints a clean ordinal', () => {
  // This is the self-heal runBatch performs after a `cold-write-failed`: the
  // claim is dropped, and the allocator — now aware of the orphan via the
  // failure ledger — issues a fresh id instead of the dead one.
  const record = {
    state: {
      nodeClaims: { 22: { ordinal: 1 } },
      archive: [],
      lastFailures: [{ rangeStart: 22, nodeId: 'archived_key_1', state: 'cold-write-failed' }],
    },
  }
  const claims = claimsOfRecord(record)
  delete claims[22]
  const allocator = makeOrdinalAllocator(record)
  assert.notEqual(allocator.next(), 1, 'the orphaned id must not be re-issued for the same range')
})
