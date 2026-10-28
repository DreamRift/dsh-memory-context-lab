/**
 * v3 摄入断点持久性守卫（H-01，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * 断点 entry.lastSeq 只活在内存里（v3-entry 每次装配都从 -1 起），记录 ID 又是
 * random.uuid() 派生而非来源事件的确定性函数 → 同一数据根第二次装载（DSH 重启 /
 * 插件重载 / dispose 后重新挂载）会把 session.log 全量历史再落一遍：
 * records/ 与 transactions.jsonl 线性翻倍。真机影子库里实测 4618 条记录只有 2315 个
 * 不同来源事件（2303 条重复）。
 *
 * ## 判据
 * - 同一 root 二次装载后，记录数与事务行数必须与首装一致（重放幂等）；
 * - 二次装载后新到事件仍必须摄入（断点不得过冲：跳过没落库的事件比重复更糟）；
 * - 断点由已提交记录的 provenance.sourceEventId 反推，形态解析只有一个真源
 *   （dsh-host 的 dshEventIdOfSeq / seqOfDshEventId）。
 *
 * ## 不适用条件与已知边界
 * - 只覆盖同一数据根的重装载；跨进程并发写由 write-lock 面负责（不在本套件）；
 * - 历史遗留的重复记录不会被本修复删除（去重属存量迁移，需产品拍板）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { dshEventIdOfSeq, seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'

function fakeSession(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: events.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const seq = events.length
      events.push({ seq, type, at: seq, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: 'enter' }) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-checkpoint-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function mountAndIngest(root, session) {
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  await ctx.callPreStep({ session }, { kind: 'enter' })
  await engine._waitForIdle()
  return { ctx, engine }
}

async function countsOf(root, sessionId) {
  const dir = path.join(root, 'sessions', sessionId)
  const records = (await readdir(path.join(dir, 'records')).catch(() => [])).filter((f) => f.endsWith('.json'))
  const txn = (await readFile(path.join(dir, 'transactions.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter((line) => line.trim().length > 0)
  return { records: records.length, txn: txn.length }
}

test('H-01 重放幂等：同一数据根二次装载不再重复落库', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-replay')
    for (let i = 0; i < 5; i += 1) {
      session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '消息' + i }] } })
    }
    const first = await mountAndIngest(root, session)
    assert.equal(first.engine.stats()['s-replay'].lastSeq, 4, '首装摄入到 seq=4')
    // 批量提交（beta.11）：5 条事件共用一笔事务，所以事务行数不是 5。
    // 幂等判据是「重载前后完全相同」，不是某个固定数字。
    const firstCounts = await countsOf(root, 's-replay')
    assert.equal(firstCounts.records, 5)
    assert.equal(firstCounts.txn, 1, '一批事件共用一笔事务（逐事件事务在回填时是 O(N) 次写）')
    first.engine.dispose()

    const second = await mountAndIngest(root, session)
    assert.deepEqual(await countsOf(root, 's-replay'), firstCounts, '重载后不得重复落库')
    assert.equal(second.engine.stats()['s-replay'].lastSeq, 4, '断点从库反推（不是 -1）')
    second.engine.dispose()
  })
})

test('H-01 断点不过冲：重载后新到事件仍摄入', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-resume')
    session.push('user/message', { data: { text: '旧一' } })
    session.push('assistant/message', { data: { content: [{ type: 'text', text: '旧二' }] } })
    const first = await mountAndIngest(root, session)
    const firstCounts = await countsOf(root, 's-resume')
    assert.equal(firstCounts.records, 2)
    assert.equal(firstCounts.txn, 1, '一批事件共用一笔事务')
    first.engine.dispose()

    session.push('tool/result', { data: { content: [{ type: 'text', text: '新三' }] } })
    const second = await mountAndIngest(root, session)
    const resumed = await countsOf(root, 's-resume')
    assert.equal(resumed.records, 3, '新事件必须落库（断点不得跳过）')
    assert.equal(resumed.txn, firstCounts.txn + 1, '新事件单独一批事务')
    assert.equal(second.engine.stats()['s-resume'].lastSeq, 2)
    second.engine.dispose()
  })
})

test('H-01 断点不因「被跳过的非记忆事件」过冲：system 之后的新记忆事件仍入库', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-sys')
    session.push('user/message', { data: { text: '甲' } })
    const first = await mountAndIngest(root, session)
    first.engine.dispose()

    session.push('system/message')
    session.push('system/message')
    session.push('user/message', { data: { text: '乙' } })
    const second = await mountAndIngest(root, session)
    const texts = []
    const dir = path.join(root, 'sessions', 's-sys', 'records')
    for (const f of await readdir(dir)) texts.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')).payload.text)
    assert.deepEqual(texts.sort(), ['乙', '甲'].sort(), '两条真人消息都在，且不重复')
    second.engine.dispose()
  })
})

test('H-02 遗忘不使断点回退：最新一条被遗忘后重载不得重新落库（隐私面）', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-forget')
    for (const text of ['第一条', '第二条', '第三条秘密']) {
      session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    }
    const first = await mountAndIngest(root, session)
    assert.equal(first.engine.stats()['s-forget'].lastSeq, 2)
    const recDir = path.join(root, 'sessions', 's-forget', 'records')
    let target = null
    for (const name of await readdir(recDir)) {
      const record = JSON.parse(await readFile(path.join(recDir, name), 'utf8'))
      if (record.payload.text === '第三条秘密') target = record
    }
    assert.ok(target !== null, '夹具：找到目标记录')
    first.engine.dispose()

    const { createV3Runtime } = await import('../src/v3/composition/composition.mjs')
    const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-forget' })
    await runtime.lifecycle.forget({ recordIds: [target.id] })
    runtime.close()

    const second = await mountAndIngest(root, session)
    const hits = []
    for (const name of await readdir(recDir)) {
      const record = JSON.parse(await readFile(path.join(recDir, name), 'utf8'))
      if (record.payload.text === '第三条秘密') hits.push(record.id)
    }
    assert.equal(second.engine.stats()['s-forget'].lastSeq, 2, '断点按「曾提交」反推，不因遗忘回退')
    assert.deepEqual(hits, [target.id], '已遗忘正文不得被重放重新落成新记录（遗忘只隐藏、不复活）')
    second.engine.dispose()

    const verify = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-forget' })
    await assert.rejects(() => verify.provider.read(target.id), (e) => e?.code === 'EFORGOTTEN', '遗忘仍然生效')
    verify.close()
  })
})

test('事件 ID 形态单一真源：seqOfDshEventId 只认 dsh-<非负安全整数>', () => {
  assert.equal(dshEventIdOfSeq(0), 'dsh-0')
  assert.equal(seqOfDshEventId('dsh-0'), 0)
  assert.equal(seqOfDshEventId('dsh-12345'), 12345)
  for (const bad of ['', 'dsh-', 'dsh--1', 'dsh-1.5', 'dsh-abc', 'evt-1', 'Dsh-3', 'dsh- 3', null, undefined, 42]) {
    assert.equal(seqOfDshEventId(bad), null, '非法形态必须返回 null（不猜、不归一）：' + String(bad))
  }
})
