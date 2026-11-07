/**
 * T-12 守卫（0.15.4）：在飞归档必须被淘汰判据看见。
 *
 * 旧缺陷：`busy` 只看摄入 `inflight` / 回填 / 待建，**不含 `archiveInflight`**。
 * 归档可跑数秒（真实会话首选段扫描 3 s+），期间淘汰扫描判它「空闲」→ close()
 * → 归档中途 ESTORE_CLOSED。两条机制各自正确，只是互不相识。
 *
 * 行为面沿 v3-runtime-eviction 的既有夹具与 `_evictNow/_touchRuntime` 测试面：
 * 同一批两个会话，一个置在飞归档、一个不置，跑同一次淘汰看谁被关。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const liveKeys = (engine) => Object.keys(engine.stats()).filter((k) => k !== 'ingestMetrics' && k !== 'injection')

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
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

test('T-12：淘汰的 busy 判据必须包含 archiveInflight（静态）', async () => {
  const text = await readFile(path.join(SRC, 'v3', 'entry', 'v3-entry.mjs'), 'utf8')
  const start = text.indexOf('function evictIdleRuntimes')
  assert.ok(start > 0, '找不到 evictIdleRuntimes')
  const body = text.slice(start, start + 1600)
  const at = body.indexOf('const busy')
  assert.ok(at > 0, '找不到 busy 判据')
  const busyBlock = body.slice(at, body.indexOf('const victims'))
  assert.ok(busyBlock.includes('archiveInflight'), 'busy 判据必须包含 archiveInflight：' + busyBlock.trim())
  assert.ok(busyBlock.includes('inflight'), 'busy 判据仍须包含摄入 inflight')
})

test('T-12：在飞归档的会话不被淘汰，空闲会话会被淘汰（行为对照）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't12-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, maxLiveSessions: 2, idleTtlMs: 60000 })
  try {
    for (const id of ['s-busy', 's-idle']) {
      const session = fakeSession(id)
      session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: id + ' 的消息' }] } })
      await ctx.callPreStep(session)
      await engine._waitForIdle()
    }
    assert.deepEqual(liveKeys(engine).sort(), ['s-busy', 's-idle'], '夹具：两个 runtime 都已建立')

    // 把 s-busy 标成「归档在飞」。`archiveInflight` 就是该条目的公开字段，
    // 归档主路径写的也是它（archive 前置单飞行）。
    const busyEntry = engine._runtimeEntryForTest?.('s-busy')
    assert.ok(busyEntry, '需要引擎的 runtime 条目测试面')
    let release
    busyEntry.archiveInflight = new Promise((resolve) => { release = resolve })

    // 两个都「很久没用」，逼淘汰必须做决定；上限 2 已满，不加新会话时
    // 走空闲 TTL 分支即可。
    const now = Date.now()
    engine._touchRuntime('s-busy', now - 600000)
    engine._touchRuntime('s-idle', now - 600000)
    engine._evictNow()

    assert.deepEqual(liveKeys(engine), ['s-busy'], '只有在飞归档的那个应当活下来')
    release()
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
