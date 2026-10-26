import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

function fakeSession(id) {
  let seq = 0
  const events = []
  const store = new Map()
  const session = {
    id,
    log: events,
    events: () => events,
    surface: { nodes: [] },
    append(type, data) {
      seq += 1
      store.set(seq, { seq, type, data })
      session.surface.nodes = [...session.surface.nodes, seq]
      return { seq }
    },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const s = events.length
      events.push({ seq: s, type, at: s, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
  return session
}

function fakeCtx() {
  const listeners = new Map()
  return {
    logger: { warn() {}, error() {} },
    dsh: {
      events: () => [],
      nodeWriteLock: async (file, body) => body(),
    },
    on: (topic, fn) => { listeners.set(topic, fn) },
    once: () => {},
    _listeners: listeners,
  }
}

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h27-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    return await body({ ctx, engine, root })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-27 键形态脱敏：命中即整值替换（含中文/大小写变体），非敏感键正文保持', async () => {
  await withEngine(async ({ ctx, engine, root }) => {
    const handler = ctx._listeners.get('agent/pre-step')
    const session = fakeSession('s-h27')
    session.push('tool/call', { data: { name: 'probe', callId: 'c1', arguments: JSON.stringify({
        apiKey: 'sk-1234567890abcdef',
        query: '这是正常查询词',
        密码: 'hunter2-strong',
        Authorization: 'Bearer abc.def.ghi',
        nested: { sessionId: 'sess-x', depth: '保留值' },
      }) } })
    await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()

    // 找到落库记录并验证脱敏面
    const sessDir = path.join(root, 'sessions', 's-h27', 'records')
    const files = await readdir(sessDir)
    let text = ''
    for (const f of files) text += await readFile(path.join(sessDir, f), 'utf8')
    assert.ok(!text.includes('sk-1234567890abcdef'), 'apiKey 值不落库')
    assert.ok(!text.includes('hunter2-strong'), '中文密码键的值不落库')
    assert.ok(!text.includes('Bearer abc.def.ghi'), 'Authorization 键（大小写变体）值不落库')
    assert.ok(!text.includes('sess-x'), '嵌套 sessionId 值不落库')
    assert.ok(text.includes('这是正常查询词'), '非敏感正文保持')
    assert.ok(text.includes('保留值'), '嵌套非敏感值保持')
  })
})
