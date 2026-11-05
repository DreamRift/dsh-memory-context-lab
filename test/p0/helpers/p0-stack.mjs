/**
 * P0 红色基线夹具的公共装配（仅测试域，不进入正常 CI）。
 *
 * 用**真实入口** attachV3Engine + 真实 pre-step 钩子 + 真实 T1/SessionStore：
 * - 事件形状与 test/helpers/fake-session.mjs 对齐（宿主 surface fold 的最小面）；
 * - 建库/摄入是后台任务，必须 _waitForIdle 后才检索；
 * - 每个用例自建临时 v3Root，结束 dispose + 删除，不触碰正式会话库或 profile。
 *
 * 已知边界：这是合成夹具（正文为标记化假数据），不是真实宿主/模型观测。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../../../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from '../../helpers/fake-session.mjs'

/**
 * @param {object} options
 * @param {string} options.id 合成会话 id
 * @param {(session: object) => void} options.seed 往假会话写事件
 * @param {number} [options.contextWindow]
 * @param {(env: {engine: object, session: object, root: string, id: string}) => Promise<void>} run
 */
export async function withEngineSession({ id = 'p0-session', seed, contextWindow = 1000000 } = {}, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p0-'))
  const hooks = []
  const ctx = {
    on(name, handler, opts) { hooks.push({ name, handler, opts }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(contextWindow)
    seed?.(session)
    for (const { name, handler, opts } of hooks) {
      if (name !== 'agent/pre-step' || opts?.prepend === true) continue
      await handler({ agent: { session }, turn: 1, step: 1, signal: { aborted: false }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    }
    await engine._waitForIdle()
    await run({ engine, session, root, id })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
