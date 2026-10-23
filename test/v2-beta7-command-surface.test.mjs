/**
 * 0.13.2-beta.7 守卫（C 组）：命令面是宿主契约的**唯一强制点**。
 *
 * ## 缺陷（L-2）
 * `withHostContract` 只包**返回值**，不包**抛出**：
 *
 *     withHostContract(domain) → async (...args) => toHostResult(await value(...args))
 *
 * 状态损坏时 `adopt()` 显式 rethrow `ESTATEDAMAGED`（这是 beta.6 刚确立的
 * 「损坏不是从未启用」），它穿过 `commandHandler` 的 30 分支 switch、穿过
 * `index.mjs` 那层只有 `finally` 的包装，直接落到宿主。宿主的命令面拿到的是一个
 * **抛出的异常**而不是 `{kind:'error'}`——用户看到的是宿主级崩溃，插件准备好的
 * 解释文案（「不会把它当作从未启用，也不会覆盖它」）一个字都到不了。
 *
 * ## 为什么是「契约层」而不是「调用点」
 * 三条命令域各自 `withHostContract`、30 个 case 各自返回、两处包装各自 try/finally——
 * 契约靠每处自觉。判据不是「这次不崩」，而是：**新增第 31 个 case 时，不必记得
 * 加 try/catch 也不会穿**。所以强制点必须落在**命令面出口**这一层（`withCommandSurface`），
 * 由 runtime 与 index 两处共同经过它。
 *
 * ## 判据（改回去必红）
 * 1. 状态文件损坏时 `commandHandler({rawInput:'status'})` **resolve** 出
 *    `kind:'error'` + `code:'ESTATEDAMAGED'` + 非空 `text`（宿主 normalizeResult
 *    对 error 分支要求非空 text，缺了就是 TypeError）；
 * 2. 任意 `EngineV2Error` 抛出 → 转成同 code 的错误结果；
 * 3. 非 `EngineV2Error` 的意外抛出也不得穿（`EV2UNEXPECTED`），但原文要留在 text 里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { EngineV2Error } from '../src/errors.mjs'
import { ensureLabRoot } from '../src/storage.mjs'
import { v2SessionDirectoryFor } from '../src/v2/state.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { withCommandSurface } from '../src/v2/command-surface.mjs'
import { toHostResult } from '../src/v2/command-result.mjs'

const SESSION_ID = 'beta7cmdsurface0000abcd'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-beta7-${name}-`))
  await ensureLabRoot(root)
  return root
}

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

function makeRuntime(labRoot) {
  return createV2Runtime({
    labRoot,
    services: { get: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'test',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    coordinator: null,
    suppressionUnavailableReason: '测试环境无抑制协调器',
  })
}

test('C-1：状态文件损坏时命令面返回 ESTATEDAMAGED 错误结果，而不是把异常抛给宿主', async () => {
  const root = await makeLabRoot('damaged')
  try {
    const first = makeRuntime(root)
    const agent = fakeAgent()
    const enabled = await first.commandHandler({ agent, rawInput: 'on', signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)

    // 制造真实损坏形态：state.json 不是合法 JSON（崩溃窗口里的半截写）。
    const directory = v2SessionDirectoryFor(root, SESSION_ID)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'state.json'), '{"kind":"dsh-memory-context-lab/v2/session",', 'utf8')

    // 新实例 = 进程重启：进程内记录为空，只能从磁盘 adopt → 撞上损坏。
    const second = makeRuntime(root)
    const result = await second.commandHandler({ agent, rawInput: 'status', signal: new AbortController().signal })

    assert.equal(result.kind, 'error', `命令面必须返回错误结果而不是抛穿：${JSON.stringify(result)}`)
    assert.equal(result.code, 'ESTATEDAMAGED')
    assert.equal(typeof result.text, 'string')
    assert.ok(result.text.trim().length > 0, '宿主对 error 分支要求非空 text，否则 TypeError')
    assert.match(result.text, /状态文件|损坏|不可/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('C-1：EngineV2Error 抛出 → 同 code 的错误结果（任何 case 都不必自带 try/catch）', async () => {
  const surface = withCommandSurface({
    boom: async () => { throw new EngineV2Error('账本坏了', { code: 'EDAMAGED' }) },
    ok: async () => ({ kind: 'success', text: 'fine' }),
  })
  const boom = await surface.boom()
  assert.equal(boom.kind, 'error')
  assert.equal(boom.code, 'EDAMAGED')
  assert.equal(boom.text, '账本坏了')
  const ok = await surface.ok()
  assert.equal(ok.kind, 'success')
})

test('C-1：意外抛出（非 EngineV2Error）也不得穿出命令面，且原文要保留', async () => {
  const surface = withCommandSurface({
    boom: async () => { throw new TypeError('x is not iterable') },
  })
  const result = await surface.boom()
  assert.equal(result.kind, 'error')
  assert.equal(result.code, 'EV2UNEXPECTED')
  assert.match(result.text, /x is not iterable/)
})

test('C-1：toHostResult 对非 error 结果原样返回（幂等，不改变成功形状）', () => {
  const success = { kind: 'success', text: 'ok' }
  assert.equal(toHostResult(success), success)
  const error = toHostResult({ kind: 'error', code: 'EINVAL', message: '用法' })
  assert.equal(error.text, '用法')
  assert.equal(toHostResult(error), error)
})
