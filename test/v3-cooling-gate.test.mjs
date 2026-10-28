/**
 * 0.14.0-beta.44：冷却闸门的预览与执行必须同一判据；按步归档的事实要可见。
 *
 * 0.14.0-beta.43 的两个诊断缺陷：
 * - dryRunArchive 直接 planSteps，不看闸门 → status 显示「候选」而真实是 cooling-closed；
 * - archiveStepOnce 成功后不写 any 归档事实 → 切模式确认与状态行都看不到按步归档。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function buildSession(id) {
  const session = createFakeSession({ id })
  session.pushContextWindow(100000)
  session.pushUser('逐步处理')
  for (let index = 1; index <= 8; index += 1) {
    session.append('step/start', { turn: 1, step: index })
    session.append('assistant/message', {
      turn: 1,
      step: index,
      message: { id: 'm' + index, role: 'assistant', content: [{ type: 'text', text: '步骤' + index + ' ' + '数据'.repeat(300) }] },
      usage: { inputTokens: 60000, outputTokens: 10, totalTokens: 60010 },
    })
    session.append('step/end', { turn: 1, step: index })
  }
  return session
}

test('冷却：gate95 preview=执行=cooling-closed；gate0 归档后 lastArchiveAt 可见且回合位点不变', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-cooling-gate-'))
  const settings = { fullHistory: true, planFirst: false, autoRestore: true, coolingGate: 95 }
  const hooks = []
  const ctx = { on(name, handler) { hooks.push(handler); return () => {} }, logger: { warn() {}, info() {} } }
  const engine = attachV3Engine(ctx, { v3Root: root, settingsNow: () => settings, defaultEnabled: true })
  try {
    const id = 's-cooling-gate'
    const session = buildSession(id)
    await engine.setControl(id, { enabled: true })
    await engine.setState(id, { mode: 'cooling' })
    await hooks[0]({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
    await engine._waitForIdle()

    const dry = await engine.dryRunArchive(id, session, settings)
    assert.equal(dry.status, 'cooling-closed', '闸门未开时预览必须说 cooling-closed，不能显示候选')
    assert.equal(dry.gate, 95)
    assert.ok(Math.abs(dry.occupancy - 0.6) < 1e-9)

    const closed = await engine.archiveForStep(id, session, settings)
    assert.equal(closed.status, 'cooling-closed')
    assert.equal(engine.stateOf(id).cooling.open, false)

    settings.coolingGate = 0
    const archived = await engine.archiveForStep(id, session, settings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    const state = engine.stateOf(id)
    assert.equal(state.surface.lastArchiveEndSeq, -1, '按步归档不得写回合级位点')
    assert.ok(Number.isFinite(state.surface.lastArchiveAt) && state.surface.lastArchiveAt > 0, '必须留下「压过历史」的事实')
    const history = await engine.historyOf(id)
    assert.equal(history.total, 1)
    const status = engine.statusOf(id)
    assert.equal(status.surface.lastArchiveAt, state.surface.lastArchiveAt, '投影必须带 lastArchiveAt')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
