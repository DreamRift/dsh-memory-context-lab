/**
 * AUD50-04-02（B2-8）：打开会话 O(记录数) 全量读记录 → 事件→记录检查点。
 *
 * 修前：resumeCheckpointOf 对每条已提交记录调 readProvenance（读整条记录含 payload），
 * 大会话打开时间随记录数线性增长（7215 条 623ms、5431 条 1226ms）。
 * 修法：checkpoint.jsonl 与提交同锁追加（baseline 行 = 全量扫描基线，checkpoint 行 =
 * 每笔事务增量）；打开时检查点 txn 与事务日志 maxTxn 一致才走快路，缺失/损坏/落后
 * 一律回退全量扫描并重写基线——失败关闭，不用旧检查点掩盖新记录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { dshEventIdOfSeq } from '../src/v3/adapters/host/dsh-host.mjs'

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (session, decision = { kind: "enter" }) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => decision)
  }
  return ctx
}

function fakeSession(id, count) {
  const events = []
  for (let i = 0; i < count; i += 1) {
    events.push({ seq: i, type: "user/message", at: i, data: { source: { kind: "user" }, content: [{ type: "text", text: id + " 消息 " + i }] } })
  }
  return { id, log: events, surface: { nodes: [] }, append() { return { seq: events.length } }, eventAt() { return undefined }, deriveMessages() { return [] } }
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-open-checkpoint-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const COUNT = 120 // 跨 INGEST_BATCH=100 → 两笔事务、两条检查点增量行

test('B2-8 第二次打开走检查点快路：无全量扫描回退、断点正确', async () => {
  await withRoot(async (root) => {
    const first = fakeCtx()
    const engine1 = attachV3Engine(first, { v3Root: root })
    await first.callPreStep(fakeSession('s-ckpt', COUNT), { kind: 'enter' })
    await engine1._waitForIdle()
    assert.equal(engine1.stats()['s-ckpt'].lastSeq, COUNT - 1)
    engine1.dispose()

    // 第二次打开：检查点 txn 与日志 maxTxn 一致 → 快路，不回退全量扫描
    const second = fakeCtx()
    const engine2 = attachV3Engine(second, { v3Root: root })
    await second.callPreStep(fakeSession('s-ckpt', COUNT), { kind: 'enter' })
    await engine2._waitForIdle()
    try {
      assert.equal(second.warnings.some((w) => w.includes('回退全量扫描')), false, '不得回退全量扫描：' + JSON.stringify(second.warnings))
      assert.equal(engine2.stats()['s-ckpt'].lastSeq, COUNT - 1, '检查点恢复的断点与全量扫描一致')
    } finally {
      engine2.dispose()
    }
    // store 层：检查点可用且 txn 对齐
    const { store } = await createSessionStorePort(root, 's-ckpt')
    try {
      const checkpoint = await store.readCheckpoint()
      assert.equal(checkpoint.usable, true, JSON.stringify(checkpoint).slice(0, 200))
      assert.equal(checkpoint.txn, 2)
      assert.ok(checkpoint.pairs.length >= COUNT, "检查点覆盖全部提交记录（实测 " + checkpoint.pairs.length + "）")
    } finally {
      store.close()
    }
  })
})

test('B2-8 检查点落后（绕过端口的直接提交）→ 回退全量扫描并重写基线', async () => {
  await withRoot(async (root) => {
    const first = fakeCtx()
    const engine1 = attachV3Engine(first, { v3Root: root })
    await first.callPreStep(fakeSession('s-behind', COUNT), { kind: 'enter' })
    await engine1._waitForIdle()
    engine1.dispose()

    // 绕过端口：直接 store 提交一笔（不写检查点行）→ 检查点落后于日志
    const raw = await openV3SessionStore(root, 's-behind')
    const text = '直接提交的记录'
    await raw.submitTransaction([{ id: "v3r-" + "ef".repeat(8), kind: "message-user", sessionKey: "s-behind", createdAt: 1, payload: { text, bytes: Buffer.byteLength(text, "utf8") }, provenance: { sourceEventId: dshEventIdOfSeq(COUNT), sourceForm: "live", transactionId: "tx-direct" } }])
    raw.close()

    // 重开：检查点落后 → 回退全量扫描（warn 可见），断点含新提交
    const second = fakeCtx()
    const engine2 = attachV3Engine(second, { v3Root: root })
    await second.callPreStep(fakeSession('s-behind', COUNT), { kind: 'enter' })
    await engine2._waitForIdle()
    try {
      assert.equal(second.warnings.some((w) => w.includes('回退全量扫描')), true, '落后必须回退（不用旧检查点掩盖新记录）')
      assert.equal(engine2.stats()['s-behind'].lastSeq, COUNT, '断点含绕过检查点的新提交')
    } finally {
      engine2.dispose()
    }
    // 回退扫描已把基线写回 → 第三次打开恢复快路
    const third = fakeCtx()
    const engine3 = attachV3Engine(third, { v3Root: root })
    await third.callPreStep(fakeSession('s-behind', COUNT), { kind: 'enter' })
    await engine3._waitForIdle()
    try {
      assert.equal(third.warnings.some((w) => w.includes('回退全量扫描')), false, '基线重写后应恢复快路：' + JSON.stringify(third.warnings))
      assert.equal(engine3.stats()['s-behind'].lastSeq, COUNT)
      // 坏检查点曾把「空映射」当最新 → 断点回 -1 → 全量重摄、记录翻倍（debug 实测）。
      const recDir = path.join(root, 'sessions', 's-behind', 'records')
      assert.equal((await readdir(recDir)).filter((n) => n.endsWith('.json')).length, COUNT + 1, '不得重复落库')
    } finally {
      engine3.dispose()
    }
  })
})

test('B2-8 检查点损坏 → 不静默使用，回退全量扫描且断点正确', async () => {
  await withRoot(async (root) => {
    const first = fakeCtx()
    const engine1 = attachV3Engine(first, { v3Root: root })
    await first.callPreStep(fakeSession('s-corrupt', COUNT), { kind: 'enter' })
    await engine1._waitForIdle()
    engine1.dispose()

    await appendFile(path.join(root, 'sessions', 's-corrupt', 'checkpoint.jsonl'), 'garbage-no-newline')

    const second = fakeCtx()
    const engine2 = attachV3Engine(second, { v3Root: root })
    await second.callPreStep(fakeSession('s-corrupt', COUNT), { kind: 'enter' })
    await engine2._waitForIdle()
    try {
      assert.equal(second.warnings.some((w) => w.includes('回退全量扫描')), true, '损坏的检查点必须回退')
      assert.equal(engine2.stats()['s-corrupt'].lastSeq, COUNT - 1, '回退扫描的断点仍然正确')
    } finally {
      engine2.dispose()
    }
  })
})
