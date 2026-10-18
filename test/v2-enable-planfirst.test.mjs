/**
 * P1-1 onEnabled 失败语义（0.12.0）。
 *
 * 缺陷：`runtime.mjs` 仍是 `onEnabled?.(agent)?.catch(...)`；`index.mjs` 注入的
 * 返回的是 plan-first 的**同步**对象 → `.catch` 为 undefined → TypeError。
 * 位置在 `enable()` 尾部、records.set 与状态落盘**之后**且不在 try 内，所以
 * 「失败关闭」完全没生效：命令显示失败，引擎已启用。
 *
 * 验收：同步不抛错；异步正常 await；抛错时命令 success + 降级提示（「计划先行未生效」）。
 * 这个缺陷此前是**零覆盖**（test/ 全仓无 onEnabled 引用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createV2Runtime } from '../src/v2/runtime.mjs'

const SESSION_ID = 'planfirst0000000000abcd'

function fakeAgent(sessionId = SESSION_ID) {
  return {
    session: {
      id: sessionId,
      surface: { nodes: [], replaceGeneration: 0 },
      events: { on() {}, off() {} },
      on() { return () => {} },
    },
    on() { return () => {} },
  }
}

async function withLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2pf-${name}-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await body(path.join(root, '.memory-context-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function runtimeWith(labRoot, onEnabled) {
  return createV2Runtime({
    labRoot,
    services: new Map(),
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'test-host',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    onEnabled,
  })
}

test('P1-1a 同步返回值不抛错：命令成功，且提示文本被带上', async () => {
  await withLab('sync', async (labRoot) => {
    const runtime = runtimeWith(labRoot, () => ({ text: '已进入计划模式（计划先行）。' }))
    try {
      const agent = fakeAgent()
      const outcome = await runtime.enable({ agent })
      assert.equal(outcome.kind, 'success')
      assert.match(outcome.text, /已进入计划模式/)
      assert.equal(outcome.text.includes('计划先行未生效'), false)
      assert.equal(runtime.records.has(SESSION_ID), true, '引擎必须真的启用')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('P1-1b 同步返回 null 同样不抛错（最常见路径：开关为关）', async () => {
  await withLab('null', async (labRoot) => {
    const runtime = runtimeWith(labRoot, () => null)
    try {
      const outcome = await runtime.enable({ agent: fakeAgent() })
      assert.equal(outcome.kind, 'success')
      assert.equal(outcome.text.includes('计划先行未生效'), false)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('P1-1c 异步返回值被正常 await（提示文本在命令返回前就绪）', async () => {
  await withLab('async', async (labRoot) => {
    const runtime = runtimeWith(labRoot, async () => ({ text: '异步计划先行提示。' }))
    try {
      const outcome = await runtime.enable({ agent: fakeAgent() })
      assert.equal(outcome.kind, 'success')
      assert.match(outcome.text, /异步计划先行提示/)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('P1-1d 抛错时命令仍 success + 降级提示「计划先行未生效」（失败关闭只作用于计划联动）', async () => {
  await withLab('throw', async (labRoot) => {
    const runtime = runtimeWith(labRoot, () => { throw new Error('计划先行进入失败') })
    try {
      const outcome = await runtime.enable({ agent: fakeAgent() })
      assert.equal(outcome.kind, 'success', '引擎已启用，命令不得报失败')
      assert.match(outcome.text, /计划先行未生效/)
      assert.equal(runtime.records.has(SESSION_ID), true)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('P1-1e 异步 rejection 同样降级为提示，不把整条命令打成失败', async () => {
  await withLab('reject', async (labRoot) => {
    const runtime = runtimeWith(labRoot, async () => { throw new Error('异步失败') })
    try {
      const outcome = await runtime.enable({ agent: fakeAgent() })
      assert.equal(outcome.kind, 'success')
      assert.match(outcome.text, /计划先行未生效/)
    } finally {
      await runtime.shutdown()
    }
  })
})
