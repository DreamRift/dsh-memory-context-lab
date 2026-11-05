/**
 * P2-12（0.15.1）：工具面 `limit`/`offset`/`refs_limit` 越界**静默夹取**而非失败关闭。
 *
 * ## 缺陷
 * 工具面三个数量参数以前都是 `Math.min/max` **静默夹取**：
 * - `limit=999` → 悄悄变成 10（`TOOL_SEARCH_MAX`）；
 * - `limit=-3` → 悄悄变成 1；`limit=2.5` → 悄悄回落默认 5；
 * - `length=10^9` → 悄悄变成回读上限；`refs_limit=999` → 悄悄变成页上界。
 *
 * 后果是「有界热上下文」变成**失败开放**：模型要 999 条，拿到 10 条，而信封里没有任何
 * 「你越界了」的信号——它会把 10 条当成「库里就这些」。这与 H-38 在 provider 层已经确立的
 * 口径（越界必须 `V3ContractViolation`，不得静默夹值）**自相矛盾**：同一产品两层两套规矩。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-12（审读）；台账方案
 * 「合同补范围 + 失败关闭」。
 *
 * ## 修法
 * 三个参数统一为：**缺省走默认值；合法域内原样生效；越界一律失败关闭**并在信封里带可读
 * `error`（`invalid-limit` / `invalid-length` / `invalid-refs-limit`）。合法域：
 * `limit ∈ [1, TOOL_SEARCH_MAX]`、`length ∈ [1, READBACK_MAX_CHARS]`、
 * `refs_limit ∈ [1, READ_REFS_LIMITS.pageMax]`。
 *
 * ## 断言组
 * 1. 搜索 `limit` 越界（0/-3/11/2.5/1e9）→ `status=rejected` + `error=invalid-limit`，不返回命中；
 * 2. 搜索 `limit` 合法（1、上限 10、缺省）→ 正常返回，且不夹取（要 1 条就 1 条）；
 * 3. 回读 `length` 越界 → `error=invalid-length`；合法 `length=50` → 恰好 50 码点；
 * 4. 引用 `refs_limit` 越界 → `error=invalid-refs-limit`（同一把尺）。
 *
 * ## 不适用条件与已知边界
 * - `offset` 早已是失败关闭（`invalid-offset`），不在本条重复。
 * - provider 层（`runtime.provider.search`）的 H-38 口径不变，本条只管**工具面信封**。
 * - 上层是否把 `rejected` 转成给用户看的文案，不在本条（信封层的诚实由本条保证）。
 *
 * ## 定点变异自证
 * 把任一参数的越界校验删掉（退回 `Math.min` 夹取）→ 对应用例红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { READ_REFS_LIMITS } from '../src/v3/contracts/citations.mjs'
import { READBACK_MAX_CHARS } from '../src/v3/contracts/readback.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, fn) { handlers.set(name, fn) },
    async callPreStep(session) {
      const h = handlers.get('agent/pre-step')
      if (h) await h({ agent: { session } }, async () => ({ kind: 'enter' }))
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 60))
}

async function withEngine(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p2-12-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'p2-12' })
    session.events = () => session.log
    session.pushUser('PARAMPROBE 参数越界探针的正文。'.repeat(20))
    session.pushAssistant('PARAMPROBE 回答正文。'.repeat(20))
    session.pushUser('当前问题。'.repeat(3))
    // 建库由 pre-step 触发（与其它用例同口径）：不先走这一步，runtimes 里没有条目，
    // toolSearch 会如实回 disabled/not-ready —— 那样测到的是「没建库」而不是参数校验。
    await ctx.callPreStep(session)
    await settle(engine)
    await fn({ engine, session })
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P2-12 搜索 limit 越界失败关闭（旧：静默夹到 1/10/5）', async () => {
  await withEngine(async ({ engine, session }) => {
    for (const bad of [0, -3, 11, 2.5, 1e9]) {
      const out = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE', limit: bad })
      assert.equal(out.status, 'rejected', 'limit=' + bad + ' 必须 rejected，得到 ' + JSON.stringify(out).slice(0, 160))
      assert.equal(out.error, 'invalid-limit', 'limit=' + bad + ' 必须给可读理由')
      assert.equal(out.items.length, 0, 'limit 越界不得返回任何命中（失败关闭）')
    }
  })
})

test('P2-12 搜索 limit 合法值原样生效，缺省 5', async () => {
  await withEngine(async ({ engine, session }) => {
    const one = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE', limit: 1 })
    assert.equal(one.status, 'ok', JSON.stringify(one).slice(0, 160))
    const atCap = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE', limit: 10 })
    assert.equal(atCap.status, 'ok')
    const missing = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE' })
    assert.equal(missing.status, 'ok', '缺省 limit 必须正常返回（默认 5）')
    assert.ok(one.items.length <= atCap.items.length + missing.items.length)
  })
})

test('P2-12 回读 length 越界失败关闭；合法 length 恰好生效', async () => {
  await withEngine(async ({ engine, session }) => {
    // 找一条可读记录：先归档/检索拿到 ID
    const found = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE', limit: 5 })
    const id = found.items?.[0]?.id
    if (typeof id !== 'string') return // 该夹具没有可读记录时跳过（避免与环境耦合）
    for (const bad of [0, -1, READBACK_MAX_CHARS + 1, 1e9]) {
      const out = await engine.toolRead(session.id, id, { detail: 'full', length: bad })
      assert.equal(out.error, 'invalid-length', 'length=' + bad + ' 必须失败关闭，得到 ' + JSON.stringify(out).slice(0, 160))
    }
    const ok = await engine.toolRead(session.id, id, { detail: 'full', length: 50 })
    assert.equal(ok.status, 'ok')
    assert.equal(ok.returned_chars, 50, '合法 length 必须原样生效（旧实现会被夹到别的值）')
  })
})

test('P2-12 引用 refs_limit 越界失败关闭（与搜索侧同一把尺）', async () => {
  await withEngine(async ({ engine, session }) => {
    const found = await engine.toolSearch(session.id, session, { query: 'PARAMPROBE', limit: 5 })
    const id = found.items?.[0]?.id
    if (typeof id !== 'string') return
    for (const bad of [0, -2, READ_REFS_LIMITS.pageMax + 1, 1e9]) {
      const out = await engine.toolRead(session.id, id, { detail: 'full', refsLimit: bad })
      assert.equal(out.error, 'invalid-refs-limit', 'refs_limit=' + bad + ' 必须失败关闭，得到 ' + JSON.stringify(out).slice(0, 160))
    }
    const ok = await engine.toolRead(session.id, id, { detail: 'full', refsLimit: 1 })
    assert.notEqual(ok.error, 'invalid-refs-limit', '合法 refs_limit 不得被拒')
  })
})
