/**
 * P0 红色基线 R08：pin/读租约的外层「读-改-写」丢并发新增。
 *
 * 判据来源：docs/dev-0.15.0/开发流程.md §7.2 R08；beta.55 C-1 登记。
 * 源码事实（v3-entry.mjs）：markReadLease 与 pinRecords 都在锁外 stateOf 后
 * 用旧数组算 patch；updateSessionState 虽锁内重读，但收到的是旧快照算出的整数组。
 *
 * 本夹具用真实 readSessionState/updateSessionState 复刻这两段外层序列（含人为对齐的
 * 陈旧快照），证明后写覆盖先写；不是直接调用私有函数，边界见证据文档。
 * 深入的跨进程/真并发夹具按用户指示转交存储实现者。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionState, updateSessionState } from '../../src/v3/adapters/storage/session-state.mjs'
import { runP0Fixture } from './harness.mjs'

const SESSION_ID = 'p0-r08'
const LEASE_A = 'v3r-00000000000000d1'
const LEASE_B = 'v3r-00000000000000d2'
const PIN_A = 'v3r-00000000000000e1'
const PIN_B = 'v3r-00000000000000e2'

function leaseRowsOf(state, extraId, now = Date.now()) {
  const live = (state.readLease ?? [])
    .filter((row) => typeof row?.recordId === 'string' && Number.isFinite(row?.expiresAt) && row.expiresAt > now)
    .map((row) => ({ recordId: row.recordId, expiresAt: row.expiresAt }))
  return [...live, { recordId: extraId, expiresAt: now + 60000 }]
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p0-r08-'))
  try { return await run(root) } finally { await rm(root, { recursive: true, force: true }).catch(() => {}) }
}

await runP0Fixture({
  id: 'R08',
  controls: ['sequential.controlKeepsBoth'],
  defects: ['lease.concurrentKeepsBoth', 'pin.concurrentKeepsBoth'],
}, async (t) => {
  // 顺序对照：证明 API/夹具可用，避免「恒红」假象。
  await withRoot(async (root) => {
    await updateSessionState(root, SESSION_ID, { readLease: [] })
    const first = readSessionState(root, SESSION_ID)
    await updateSessionState(root, SESSION_ID, { readLease: leaseRowsOf(first, LEASE_A) })
    const second = readSessionState(root, SESSION_ID)
    await updateSessionState(root, SESSION_ID, { readLease: leaseRowsOf(second, LEASE_B) })
    const final = readSessionState(root, SESSION_ID)
    const ids = (final.readLease ?? []).map((row) => row.recordId).sort()
    t.control('sequential.controlKeepsBoth', ids.length === 2 && ids[0] === LEASE_A && ids[1] === LEASE_B, '顺序写入必须都保留；若失败，夹具/API 用法有误')
  })

  await withRoot(async (root) => {
    await updateSessionState(root, SESSION_ID, { readLease: [] })
    const staleA = readSessionState(root, SESSION_ID)
    const staleB = readSessionState(root, SESSION_ID)
    await Promise.all([
      updateSessionState(root, SESSION_ID, { readLease: leaseRowsOf(staleA, LEASE_A) }),
      updateSessionState(root, SESSION_ID, { readLease: leaseRowsOf(staleB, LEASE_B) }),
    ])
    const final = readSessionState(root, SESSION_ID)
    const ids = (final.readLease ?? []).map((row) => row.recordId).sort()
    t.observe('lease.final', ids)
    t.defect('lease.concurrentKeepsBoth', ids, [LEASE_A, LEASE_B].sort(), '并发新增的 A/B 两条租约都必须保留')
  })

  await withRoot(async (root) => {
    await updateSessionState(root, SESSION_ID, { pins: [] })
    const staleA = readSessionState(root, SESSION_ID)
    const staleB = readSessionState(root, SESSION_ID)
    await Promise.all([
      updateSessionState(root, SESSION_ID, { pins: [...(staleA.pins ?? []), PIN_A] }),
      updateSessionState(root, SESSION_ID, { pins: [...(staleB.pins ?? []), PIN_B] }),
    ])
    const final = readSessionState(root, SESSION_ID)
    const ids = [...(final.pins ?? [])].sort()
    t.observe('pin.final', ids)
    t.defect('pin.concurrentKeepsBoth', ids, [PIN_A, PIN_B].sort(), '并发 pin 的两条记录都必须保留')
  })
})
