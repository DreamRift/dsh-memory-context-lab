/**
 * 0.13.0 压力闸门接线（红例先行）：默认闸门下，低占用**不得归档**。
 *
 * 与 v2-pressure-gate.test.mjs 的分工：那个套件测纯函数；这个套件测**接线**——
 * runAutoCooling 是否真的按闸门裁决办事。没有这一条，纯函数全绿也可能根本没接上
 * （改回去必红的对照组就是 if (false && !pressure.open)）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createEngine } from '../src/apply-engine.mjs'
import { buildSession, FakeColdStore, fakeMeter } from './helpers/fake-host.mjs'

function makeEngine(contextWindow = 100000) {
  return createEngine({
    persist: async () => {},
    nodeIdFor: (record, ordinal) => 'gate-node-' + ordinal,
    hostVersion: 'pressure-wiring-test',
    services: {
      get(name) {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    createClient: async () => new FakeColdStore(),
  })
}

function makeRecord(session, settings) {
  return {
    agent: { session },
    state: {
      enabled: true,
      settings: { auto: true, autoRecall: true, retainOperations: 0, archiveBatchSize: 1, ...settings },
      archive: [],
      lastMeasurement: null,
      lastFailures: [],
    },
    occupancy: null,
    occupancyError: null,
    client: null,
    clientError: null,
  }
}

test('W1 默认闸门（20%）下，低占用会话不归档且如实报 below-enter', async () => {
  const engine = makeEngine()
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const record = makeRecord(session, {})
  const outcome = await engine.runAutoCooling(record, new AbortController().signal)
  assert.equal(outcome.action, 'noop', JSON.stringify(outcome))
  assert.equal(outcome.reason, 'below-enter')
  assert.equal(record.state.archive.length, 0, '低占用不得产生任何归档行')
})

test('W2 显式关闸门（pressureGate: 0）时同一会话会归档（证明闸门是唯一差别）', async () => {
  const engine = makeEngine()
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const record = makeRecord(session, { pressureGate: 0 })
  const outcome = await engine.runAutoCooling(record, new AbortController().signal)
  assert.equal(outcome.action, 'applied', JSON.stringify(outcome))
  assert.ok(record.state.archive.length > 0)
})

test('W3 闸门裁决随占用率变化：高占用时同一会话会归档', async () => {
  // 窗口压到 8000：同样的组装量就越过 20%，闸门应开。
  const engine = makeEngine(8000)
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const record = makeRecord(session, {})
  const outcome = await engine.runAutoCooling(record, new AbortController().signal)
  assert.equal(outcome.action, 'applied', JSON.stringify(outcome))
})

test('W4 滞回状态随裁决落盘', async () => {
  const engine = makeEngine()
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const record = makeRecord(session, {})
  await engine.runAutoCooling(record, new AbortController().signal)
  assert.ok(Array.isArray(record.state.pressureSamples), '占用样本必须落盘（用于动态死区）')
  assert.ok(record.state.pressureSamples.length > 0)
  assert.equal(record.state.pressureCoolingOn, false, '未开闸时滞回状态为 false')
})