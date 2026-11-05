/**
 * R2-01 / R3-02（2026-10-30）：归档意图占槽与按身份清理。
 *
 * ## 缺陷
 * - R2-01：`writeArchiveIntent` 无条件覆盖——surface 已落面而 appendVoucher 失败时，
 *   下一笔归档仍继续，`journal.write` 覆盖未对账的旧意图，旧回执从此无法枚举补账。
 * - R3-02：无条件 clear（原 `clearArchiveIntent`，R3-02 后删除）按路径 rm——旧流程迟到的 clear 晚于新意图
 *   的 write 到达时，把同一槽位里的**新**意图删掉，补账线索丢失。
 *
 * ## 修法
 * - `reserveArchiveIntent`：会话跨进程写锁内重读校验，只有 absent（或同一 intentId
 *   幂等重占）才写入；pending/unreadable 一律拒绝且不动原字节。
 * - `clearArchiveIntentIfMatches`：锁内重读比对身份（intentId；旧格式无 ID 时比
 *   规范化全载荷指纹），不匹配返回 conflict 不删除；不可读失败关闭不盲清。
 *
 * ## 断言组
 * 1. 占槽正常路径/幂等重占/槽位被占拒绝（旧意图字节不变）；
 * 2. 按身份清理：匹配清、重复清幂等、错误 ID conflict 不删、旧格式指纹匹配清/不匹配不删；
 * 3. R3-02 编排：A 占槽→B 被拒→A 迟到清理 → B 意图仍在；
 * 4. 意图文件不可读：占槽与清理都失败关闭，字节不变；
 * 5. 同进程并发占槽恰好一个成功；两进程并发占槽恰好一个成功（子进程实测）。
 *
 * ## 定点变异自证
 * 把 reserveArchiveIntent 退回 writeArchiveIntent（无条件覆盖）→ 组 1/3/5 红；
 * 把 clearArchiveIntentIfMatches 退回无条件 rm → 组 2/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  archiveIntentPath,
  clearArchiveIntentIfMatches,
  intentFingerprintOf,
  readArchiveIntent,
  reserveArchiveIntent,
  writeArchiveIntent,
} from '../src/v3/adapters/storage/archive-intent.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-intent-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function intentOf(id, extra = {}) {
  return { schemaVersion: 1, intentId: id, sessionId: 's-intent', mode: 'full-history', txn: 1, startSeq: 2, endSeq: 3, receiptText: '回执 ' + id, createdAt: 1, ...extra }
}

test('占槽：absent 可占、同 ID 幂等重占、不同 ID 拒绝且旧字节不变', async () => {
  await withRoot(async (root) => {
    const a = intentOf('intent-a')
    const first = await reserveArchiveIntent(root, 's-intent', a)
    assert.equal(first.ok, true)
    assert.equal(first.status, 'reserved')
    assert.equal((await readArchiveIntent(root, 's-intent'))?.intentId, 'intent-a')

    // 同一 ID 重占：幂等（恢复/重试路径），不是覆盖别人的事务
    const reassert = await reserveArchiveIntent(root, 's-intent', { ...a, createdAt: 999 })
    assert.equal(reassert.ok, true)
    assert.equal(reassert.reasserted, true)

    const before = await readFile(archiveIntentPath(root, 's-intent'), 'utf8')
    const b = intentOf('intent-b')
    const second = await reserveArchiveIntent(root, 's-intent', b)
    assert.equal(second.ok, false, '未对账的旧意图不得被下一笔覆盖（R2-01）')
    assert.equal(second.status, 'pending')
    assert.equal(second.existing?.intentId, 'intent-a', '拒绝时必须带回占用者身份供诊断')
    const after = await readFile(archiveIntentPath(root, 's-intent'), 'utf8')
    assert.equal(after, before, '拒绝占槽时旧意图字节必须原样保留')
  })
})

test('按身份清理：匹配清、重复清幂等、错误 ID conflict 不删', async () => {
  await withRoot(async (root) => {
    const a = intentOf('intent-a')
    await reserveArchiveIntent(root, 's-intent', a)
    const cleared = await clearArchiveIntentIfMatches(root, 's-intent', a)
    assert.equal(cleared.ok, true)
    assert.equal(cleared.status, 'cleared')
    assert.equal(await readArchiveIntent(root, 's-intent'), null)

    // 已清后再清：幂等成功（absent），不是报错
    const again = await clearArchiveIntentIfMatches(root, 's-intent', a)
    assert.equal(again.ok, true)
    assert.equal(again.status, 'absent')

    // 槽位上是 B 时清 A：conflict，B 字节不动（R3-02 核心）
    const b = intentOf('intent-b', { createdAt: 2 })
    await reserveArchiveIntent(root, 's-intent', b)
    const stale = await clearArchiveIntentIfMatches(root, 's-intent', a)
    assert.equal(stale.ok, false)
    assert.equal(stale.status, 'conflict')
    assert.equal((await readArchiveIntent(root, 's-intent'))?.intentId, 'intent-b', '迟到的旧清理不得删除新意图')
  })
})

test('旧格式（无 intentId）按规范化载荷指纹一次性比对', async () => {
  await withRoot(async (root) => {
    const legacy = { schemaVersion: 1, sessionId: 's-intent', mode: 'cooling', txn: 3, startSeq: 4, endSeq: 9, receiptText: '旧回执', createdAt: 7 }
    // 直写场景：会话目录尚未由建库创建（生产路径上 reserve 前目录已存在）
    await mkdir(path.dirname(archiveIntentPath(root, 's-intent')), { recursive: true })
    await writeArchiveIntent(root, 's-intent', legacy)
    // 键顺序不同、内容相同 → 同一指纹
    assert.equal(intentFingerprintOf(legacy), intentFingerprintOf({ ...legacy }))
    const ok = await clearArchiveIntentIfMatches(root, 's-intent', { ...legacy, createdAt: 7 })
    assert.equal(ok.ok, true, '指纹匹配的旧格式意图可以清理')
    assert.equal(await readArchiveIntent(root, 's-intent'), null)

    await writeArchiveIntent(root, 's-intent', legacy)
    const mismatch = await clearArchiveIntentIfMatches(root, 's-intent', { ...legacy, txn: 4 })
    assert.equal(mismatch.ok, false, '载荷任何字段不同都不删除（不只比 txn/时间戳）')
    assert.equal(mismatch.status, 'conflict')
    assert.notEqual(await readArchiveIntent(root, 's-intent'), null)
  })
})

test('R3-02 编排：A 占槽 → B 被拒 → A 迟到清理 → B 的意图仍在', async () => {
  await withRoot(async (root) => {
    const a = intentOf('intent-a')
    await reserveArchiveIntent(root, 's-intent', a)
    const b = intentOf('intent-b', { createdAt: 2 })
    assert.equal((await reserveArchiveIntent(root, 's-intent', b)).ok, false, 'B 在 A 未结算时不能占槽')
    // A 的清理迟到了（此时调用方以为槽位上还是 A）：
    const late = await clearArchiveIntentIfMatches(root, 's-intent', a)
    assert.equal(late.ok, true, 'A 清自己仍在槽位的意图是正常收尾')
    // 常见时序：A 已清、B 抢占成功、A 的第二次迟到清理到达
    assert.equal((await reserveArchiveIntent(root, 's-intent', b)).ok, true, 'A 结算后 B 可占槽')
    const lateAgain = await clearArchiveIntentIfMatches(root, 's-intent', a)
    assert.equal(lateAgain.ok, false)
    assert.equal(lateAgain.status, 'conflict')
    assert.equal((await readArchiveIntent(root, 's-intent'))?.intentId, 'intent-b', 'B 的新意图必须完好')
  })
})

test('意图不可读：占槽/清理都失败关闭，字节不变', async () => {
  await withRoot(async (root) => {
    const p = archiveIntentPath(root, 's-intent')
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, '{"intentId":"broken"', 'utf8') // 半截 JSON
    const reserve = await reserveArchiveIntent(root, 's-intent', intentOf('intent-a'))
    assert.equal(reserve.ok, false, '不可读 ≠ 空：不得覆盖（R2-01 验收）')
    assert.equal(reserve.status, 'unreadable')
    const clear = await clearArchiveIntentIfMatches(root, 's-intent', intentOf('intent-a'))
    assert.equal(clear.ok, false, '不可读 ≠ absent：不得盲清（R3-02）')
    assert.equal(clear.status, 'unreadable')
    assert.equal(await readFile(p, 'utf8'), '{"intentId":"broken"', '失败关闭路径不得改字节')
  })
})

test('同进程并发占槽：恰好一个成功', async () => {
  await withRoot(async (root) => {
    const results = await Promise.all([
      reserveArchiveIntent(root, 's-intent', intentOf('intent-a')),
      reserveArchiveIntent(root, 's-intent', intentOf('intent-b', { createdAt: 2 })),
    ])
    const wins = results.filter((r) => r.ok === true)
    assert.equal(wins.length, 1, '两笔并发占槽最多一个成功（同进程串行化）')
    const winner = results.findIndex((r) => r.ok === true)
    assert.equal((await readArchiveIntent(root, 's-intent'))?.intentId, winner === 0 ? 'intent-a' : 'intent-b')
  })
})

test('两进程并发占槽：恰好一个成功（真实子进程、真抢同一空槽）', async () => {
  await withRoot(async (root) => {
    const modUrl = pathToFileURL(fileURLToPath(new URL('../src/v3/adapters/storage/archive-intent.mjs', import.meta.url))).href
    // 2026-10-31 审计修正：旧写法用 spawnSync——它**阻塞**父进程直到子进程退出，
    // 于是「父进程与子进程同时抢同一空槽」实际是先子后父的串行序列：把占槽退回无条件
    // 覆盖（R2-01 回退）这一条仍然会红，但**跨进程文件锁被拆掉**这一条永远不会红。
    // 现在用 spawn + READY/GO 握手，并跑多轮：每轮两边都在同一时间窗内进临界区。
    const childScript = `
      const fs = await import('node:fs/promises')
      const mod = await import(process.env.MCL_MOD)
      await fs.writeFile(process.env.MCL_READY, 'ready')
      while (true) {
        try { await fs.access(process.env.MCL_GO); break } catch { await new Promise((r) => setTimeout(r, 1)) }
      }
      const result = await mod.reserveArchiveIntent(process.env.MCL_ROOT, 's-cross', {
        intentId: 'intent-child', mode: 'full-history', txn: 1, createdAt: 1,
      })
      console.log('RESULT:' + JSON.stringify(result))
    `
    const rounds = 6
    let doubleWins = 0
    for (let round = 0; round < rounds; round += 1) {
      const ready = path.join(root, 'ready-' + round)
      const go = path.join(root, 'go-' + round)
      await clearArchiveIntentIfMatches(root, 's-cross', { intentId: 'intent-child' })
      await clearArchiveIntentIfMatches(root, 's-cross', { intentId: 'intent-parent' })
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        env: { ...process.env, MCL_MOD: modUrl, MCL_ROOT: root, MCL_READY: ready, MCL_GO: go },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let childOut = ''
      child.stdout.on('data', (d) => { childOut += d })
      child.stderr.on('data', (d) => { childOut += d })
      const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
      let readySeen = false
      for (let i = 0; i < 3000 && !readySeen; i += 1) {
        try { await access(ready); readySeen = true } catch { await new Promise((r) => setTimeout(r, 1)) }
      }
      assert.equal(readySeen, true, '子进程必须就绪：' + childOut)
      await writeFile(go, 'go')
      const parent = await reserveArchiveIntent(root, 's-cross', intentOf('intent-parent', { createdAt: 2 }))
      const code = await exited
      assert.equal(code, 0, '子进程正常退出：' + childOut)
      const childResult = JSON.parse(childOut.split('RESULT:')[1])
      const wins = [parent, childResult].filter((r) => r.ok === true)
      if (wins.length > 1) doubleWins += 1
      // 落盘意图必须与赢家一致；没赢的那一侧必须是 pending（不是静默覆盖）
      const stored = await readArchiveIntent(root, 's-cross')
      assert.ok(stored !== null, '必须有一方占到槽')
      const winnerId = parent.ok === true ? 'intent-parent' : 'intent-child'
      assert.equal(stored.intentId, winnerId, '第 ' + round + ' 轮落盘意图必须与赢家一致：parent=' + JSON.stringify(parent) + ' child=' + JSON.stringify(childResult))
      const loser = parent.ok === true ? childResult : parent
      assert.equal(loser.status, 'pending', '未抢到的一侧必须报 pending：' + JSON.stringify(loser))
    }
    assert.equal(doubleWins, 0, '任何一轮都不得两方同时占槽成功（R2-01 的检查-写入窗口由锁关闭）')
  })
})
