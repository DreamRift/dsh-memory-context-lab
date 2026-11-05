/**
 * I6-1 影子诊断装配守卫。
 * 判据：默认只装配函数引用，不运行候选能力；能力须由调用方显式调用。
 * 不适用：真实宿主工具集合、宿主运行时顺序与收益验证（本批仅 composition 级离线装配）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function fakeSession() {
  let seq = 0
  return {
    id: 'i6-shadow-session',
    surface: { nodes: [] },
    events: [],
    append() { seq += 1; return { seq } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
  }
}

async function withRuntime(options, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-i6-wiring-'))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: fakeSession(), ...options })
  try { return await body(runtime) } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function fakeModules(calls) {
  return {
    warm: { buildWarmSummaryReference: (input) => { calls.push(['warm', input]); return { kind: 'warm', input } } },
    compiler: { compileContext: (input) => { calls.push(['compiler', input]); return { kind: 'compiler', input } } },
    recall: { planRecall: (input) => { calls.push(['recall', input]); return { kind: 'recall', input } } },
    shadow: {
      shadowReport: (input) => { calls.push(['shadowReport', input]); return 'report' },
      compareCompressionShadow: (input) => { calls.push(['compareCompressionShadow', input]); return 'comparison' },
      guardShadowPorts: (input) => { calls.push(['guardShadowPorts', input]); return 'ports' },
    },
  }
}

test('I6-1 装配暴露全部诊断入口，默认各模块可用且不自动调用', async () => {
  await withRuntime({}, async (runtime) => {
    assert.ok(runtime.diagnostics)
    assert.deepEqual(runtime.diagnostics.available, { warm: true, compiler: true, recall: true, shadow: true })
    assert.deepEqual(runtime.diagnostics.reasons, { warm: null, compiler: null, recall: null, shadow: null })
    assert.deepEqual({ ...runtime.diagnostics.calls }, { warm: 0, compiler: 0, recall: 0, shadow: 0 }, '装配期真实诊断函数零调用')
    for (const key of ['warm', 'compiler', 'recall', 'shadow']) assert.equal(typeof runtime.diagnostics[key], 'function')
    assert.equal(runtime.diagnostics.dshOps, undefined, 'I3 dshOps 诊断项仍不存在；0.15.1 组件由 patch 行 + vendored 依赖承载')
    assert.deepEqual(Object.keys(runtime).sort(), ['close', 'clock', 'diagnostics', 'executor', 'handleDshEvent', 'handleDshEventBatch', 'hash', 'host', 'lifecycle', 'metrics', 'ownSourceKinds', 'processTurn', 'provider', 'providerDecision', 'random', 'recall', 'sessionKey', 'store', 't2'].sort(), 'runtime 仅新增 diagnostics 字段')
    const validWarmInput = {
      sessionKey: 'session-a',
      activeSurfaceNodes: [
        { seq: 1, eventId: 'host-event-1', text: '不是 X；', recordId: 'v3r-0123456789abcdef', sessionKey: 'session-a' },
        { seq: 2, eventId: 'host-event-2', text: '更正为 Y。', recordId: 'v3r-1123456789abcdef', sessionKey: 'session-a' },
      ],
      archiveCandidate: { startSeq: 1, endSeq: 2, sourceEventSeqs: [1, 2], recordIds: ['v3r-0123456789abcdef', 'v3r-1123456789abcdef'], sessionKey: 'session-a' },
      summaryBudgetCodePoints: 240,
    }
    runtime.diagnostics.warm(validWarmInput)
    assert.equal(runtime.diagnostics.calls.warm, 1, '真实静态导入函数仅在显式调用后计数')
    assert.deepEqual({ ...runtime.diagnostics.calls }, { warm: 1, compiler: 0, recall: 0, shadow: 0 })
  })
})

test('I6-1 默认关闭：装配只保留函数引用，显式调用才运行 P3/I2', async () => {
  const calls = []
  await withRuntime({ diagnosticModules: fakeModules(calls) }, async (runtime) => {
    assert.deepEqual(calls, [], '装配阶段不得运行任何被装配的能力函数')
    const d = runtime.diagnostics
    assert.deepEqual(d.warm({ x: 1 }), { kind: 'warm', input: { x: 1 } })
    assert.deepEqual(d.compiler({ x: 2 }), { kind: 'compiler', input: { x: 2 } })
    assert.deepEqual(d.recall({ x: 3 }), { kind: 'recall', input: { x: 3 } })
    assert.deepEqual(d.shadow(), { report: 'report', comparison: 'comparison', ports: 'ports' })
    assert.deepEqual(calls.map(([name]) => name), ['warm', 'compiler', 'recall', 'shadowReport', 'compareCompressionShadow', 'guardShadowPorts'])
  })
})

test('I6-1 单模块装配失败被隔离并保留原因', async () => {
  const calls = []
  const modules = fakeModules(calls)
  await withRuntime({
    diagnosticModules: { ...modules, compiler: {} },
  }, async (runtime) => {
    assert.ok(runtime)
    assert.equal(runtime.diagnostics.available.compiler, false)
    assert.match(runtime.diagnostics.reasons.compiler, /compiler 诊断模块缺少所需导出/)
    assert.equal(runtime.diagnostics.compiler, null)
    assert.equal(runtime.diagnostics.available.warm, true)
    assert.equal(calls.length, 0)
  })
})

test('I6-1 既有 processTurn 的非记忆事件结果保持不变', async () => {
  await withRuntime({}, async (runtime) => {
    const event = { seq: 7, type: 'system/message', data: {} }
    assert.deepEqual(await runtime.handleDshEvent(event, 'system text'), { status: 'not-memory-event', errors: ['DSH 事件类型不在 v3 归一化面：system/message（system/head 类不进记忆管线）'] })
  })
})

test('H7 诊断开关关闭时任何诊断函数都拒绝执行（不是「调用方记得别调」）', async () => {
  await withRuntime({ diagnosticsEnabled: () => false }, async (runtime) => {
    assert.throws(() => runtime.diagnostics.warm({}), (error) => error.code === 'EDIAGNOSTICS_DISABLED')
    assert.throws(() => runtime.diagnostics.shadow({}), (error) => error.code === 'EDIAGNOSTICS_DISABLED')
    assert.deepEqual({ ...runtime.diagnostics.calls }, { warm: 0, compiler: 0, recall: 0, shadow: 0 }, '拒绝执行不计数')
  })
  await withRuntime({ diagnosticsEnabled: () => true }, async (runtime) => {
    runtime.diagnostics.warm({})
    assert.equal(runtime.diagnostics.calls.warm, 1, '开关打开后进入真实实现并计数')
  })
})

test('H7 调用计数只读：外部赋值不能伪造「零调用」', async () => {
  await withRuntime({}, async (runtime) => {
    assert.throws(() => { runtime.diagnostics.calls.warm = 99 }, (error) => error instanceof TypeError)
    assert.equal(runtime.diagnostics.calls.warm, 0)
  })
})
