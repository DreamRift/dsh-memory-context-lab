/**
 * P1-03 / P1-04（0.15.1）：purge 的两阶段顺序与 purged 账本的 repair 收敛。
 *
 * ## 缺陷
 * - P1-03：`purge()` 先 `rm records/<id>.json` 再 append `purged.jsonl`。两步之间崩溃 →
 *   `transactions.jsonl` 有 commit 行、payload 已丢、purged 里没有这条 → 打开期判 damaged，
 *   此后**所有写入 ESTORE_DAMAGED**，`/memory-lab repair` 返回 `{changed:false}`，重开仍
 *   damaged：一个不可自愈的永久「只能读」故障态。
 * - P1-04：`repairSessionJournals` 的 specs 漏登记 `purged.jsonl` → purge 记账的尾部半行
 *   永远不可收敛（repair 说无需修复，读面却仍解析失败）。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★3 / §3.1 P1-03、P1-04；
 * 用户裁定（2026-11-04）：全部按顺序修，根因修复。
 *
 * ## 修法
 * - 两阶段：**先落 purged 账本（fsync），再删正文**。最坏情况变成「账已清、文件还在」；
 * - 打开期补完第二阶段：purgedIds 里有、盘上还有的 payload 直接删除（幂等），**不**把它
 *   当孤儿挪进 quarantine——quarantine 只进不出，已承诺物理清除的字节不能停在那里；
 * - repair specs 纳入 PURGED_LOG（与 forgotten 同族：append-only 隐私账本）。
 *
 * ## 断言组
 * 1. 崩溃等价态（账已清、payload 仍在）重开：healthy、可写、payload 被补删、不进 quarantine；
 * 2. 静态顺序守卫：`purge()` 里 appendLine(PURGED_LOG) 必须在 rm(records/…) 之前；
 * 3. purged.jsonl 尾部半行可被 repair 收敛（repaired 里出现 purged.jsonl，截断后仅剩完整行）。
 *
 * ## 不适用条件与已知边界
 * - 旧版本已经落在 damaged 态的库（无 purged 行）不在本条自愈范围：那需要人工裁决
 *   「补 purge 行 vs 找回 payload」，报告 §1★3 选项 B 属另一条处置，本仓不自动猜；
 * - 打开期补删失败（EPERM）不阻断打开：账已清、读面不会返回它，下次打开继续补。
 *
 * ## 定点变异自证
 * 把 purge() 的两行换回旧顺序（rm 在 appendLine 之前）→ 第 2 条必红；
 * 删掉打开期补完代码 → 第 1 条必红（payload 会被当孤儿挪进 quarantine）；
 * 从 repair specs 删掉 PURGED_LOG → 第 3 条必红。读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openV3SessionStore, repairSessionJournals } from '../src/v3/adapters/storage/session-store.mjs'

function hex16(n) { return n.toString(16).padStart(16, '0') }

function recordOf(n, sessionKey) {
  const text = '正文' + n
  return {
    id: 'v3r-' + hex16(n),
    kind: 'message-user',
    sessionKey,
    createdAt: 1,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-' + n, sourceForm: null, transactionId: 'tx-' + n },
  }
}

async function seededSession(sessionKey, count) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p103-'))
  const store = await openV3SessionStore(root, sessionKey)
  for (let i = 1; i <= count; i += 1) await store.submitTransaction([recordOf(i, sessionKey)])
  store.close()
  return root
}

test('P1-03 崩溃等价态：账已清、payload 仍在 → 重开健康、可写、补删正文且不进 quarantine', async () => {
  const root = await seededSession('purge-crash', 1)
  try {
    const dir = path.join(root, 'sessions', 'purge-crash')
    const id = 'v3r-' + hex16(1)
    // 模拟第一阶段完成后崩溃：purge 行已落盘（fsync），rm 之前进程被杀。
    await appendFile(path.join(dir, 'purged.jsonl'), JSON.stringify({ action: 'purge', id, at: null }) + '\n', 'utf8')
    assert.equal(existsSync(path.join(dir, 'records', id + '.json')), true, '前置：payload 还在')

    const store = await openV3SessionStore(root, 'purge-crash')
    try {
      const health = store.health()
      assert.equal(health.healthy, true, '两阶段中间态不得判损坏（旧实现这里永久 ESTORE_DAMAGED）')
      assert.equal(store.listPurged().includes(id), true, 'purge 账本事实必须可见')
      assert.equal(existsSync(path.join(dir, 'records', id + '.json')), false, '打开期必须补完第二阶段（删除正文）')
      assert.equal(existsSync(path.join(dir, 'quarantine', id + '.json')), false, '不得把已清除记录挪进 quarantine（隐私字节只进不出）')
      await assert.rejects(() => store.readRecord(id), '已 purge 记录不得可读')
      const next = await store.submitTransaction([recordOf(2, 'purge-crash')])
      assert.equal(typeof next.txn, 'number', '库必须可写')
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-03 静态顺序守卫：purge() 先落 purged 账本，再删正文', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/v3/adapters/storage/session-store.mjs', import.meta.url)), 'utf8')
  const body = source.slice(source.indexOf('async purge(id)'))
  const ledgerAt = body.indexOf("appendLine(path.join(dir, PURGED_LOG), { action: 'purge'")
  const rmAt = body.indexOf("rm(path.join(dir, RECORDS_DIR, id + '.json')")
  assert.ok(ledgerAt > 0 && rmAt > 0, '两处都必须存在（否则守卫本身失效）')
  assert.ok(ledgerAt < rmAt, '两阶段顺序：先写 purged 账本（fsync），再删正文')
})

test('R23 purged.jsonl 中段损坏：健康判据必须失败关闭，且 purge 必须被拒（不得重达 P1-03）', async () => {
  // P1-03 修的是「purge 崩溃 → 整库永久只读」。QC 复核实测出同构的另一条路：
  // purged.jsonl **中段**坏行 → 前缀里读不到的 purge 行让「commit 在、payload 已删」
  // 被判成账实不符 → 整库 ESTORE_DAMAGED，而 repair 又说不用修。
  // 判据必须与 forgotten.jsonl 同族：损坏即失败关闭，且**不许再往里追加**。
  const root = await seededSession('purged-mid-damage', 2)
  try {
    const dir = path.join(root, 'sessions', 'purged-mid-damage')
    const file = path.join(dir, 'purged.jsonl')
    await appendFile(file, JSON.stringify({ action: 'purge', id: 'v3r-' + hex16(1), at: null }) + '\n', 'utf8')
    await appendFile(file, 'NOT-JSON\n', 'utf8')  // 中段坏行（后面还有完整行）
    await appendFile(file, JSON.stringify({ action: 'purge', id: 'v3r-' + hex16(2), at: null }) + '\n', 'utf8')

    const store = await openV3SessionStore(root, 'purged-mid-damage')
    try {
      const health = store.health()
      assert.equal(health.healthy, false, 'purged 账本中段损坏必须让健康判据失败关闭（不得报 healthy）')
      assert.equal(health.purgedDamaged, true, '诊断面必须能看出是 purged 账本坏了')
      assert.match(String(health.damagedReason ?? ''), /purged\.jsonl/, '原因必须点名是哪个账本：' + String(health.damagedReason))
      await assert.rejects(() => store.purge('v3r-' + hex16(2)), (error) => {
        assert.equal(error.code, 'ESTORE_DAMAGED', '损坏时禁止 purge：' + JSON.stringify(error))
        assert.match(String(error.message), /purged\.jsonl/, '理由必须点名账本')
        return true
      }, '损坏账本必须拒绝紫色清除，否则会落下读不回来的 purge 行')
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-04 purged.jsonl 尾部半行：repair 必须能收敛', async () => {
  const root = await seededSession('repair-purged', 1)
  try {
    const dir = path.join(root, 'sessions', 'repair-purged')
    const file = path.join(dir, 'purged.jsonl')
    // 已有完整记账行（purge 过一条），再模拟记账写到一半掉电：完整行 + 无换行的半行。
    await appendFile(file, JSON.stringify({ action: 'purge', id: 'v3r-' + hex16(1), at: null }) + '\n', 'utf8')
    const before = await readFile(file, 'utf8')
    await appendFile(file, '{"action":"purge","id":"v3r-' + hex16(9) + '"', 'utf8')
    const repaired = await repairSessionJournals(dir)
    assert.deepEqual(repaired.repaired.map((row) => row.file), ['purged.jsonl'], 'purged 账本必须在 repair 面里')
    const after = await readFile(file, 'utf8')
    assert.equal(after, before, '只截掉尾部半行，完整行逐字节保留')
    const rows = after.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.every((row) => row.action === 'purge'), true)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
