/**
 * P2-14（0.15.1）：`release()` 无 try/catch → 吃掉 `next()` 的原始异常。
 *
 * ## 缺陷
 * pre-step 钩子里归还回注占位是**不设防**的：`release()` 直接调
 * `engine.releaseInjectionReservation(...)`，而它内部会碰 `injectionLeases.forget` 与
 * `confirmations.drop`（这两步没有 try/catch）。一旦归还路径自己失败（状态文件损坏、
 * 磁盘抖动、端口抛错），紧邻的下一条语句就永远不执行：
 * - 在 `catch (error) { release('next-threw'); throw error }` 里，**原始异常被替换**——
 *   真正的宿主失败连同栈一起消失，排障只看得到租约层的错；
 * - 在正常分支里，异常变成「本步整体失败」，而这条路径本应只是「本步不注入」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-14（审读）；
 * 归还实现在 src/v3/entry/v3-entry.mjs 的 releaseInjectionReservation。
 *
 * ## 修法
 * 把「安全归还」抽成导出的纯函数 `safeReleaseReservation`：**永不抛错**，失败经 onError
 * 上报（告警口自己炸也不能再抛），返回 `{ released, error }` 供观测。pre-step 的
 * `release()` 改为调用它——这样「归还失败」只能影响告警，不能改变本步结论。
 *
 * ## 断言组
 * 1. 归还成功 → `released=true, error=null`，engine 真被调用一次（原因透传）；
 * 2. 归还抛错 → **不抛**、`released=false`、error 原样带回，且 onError 被调用一次；
 * 3. onError 自己也抛错 → 仍然不抛（告警口不得毒化控制流）；
 * 4. 无引擎 / 无会话 / turn 非法 → 直接返回，不触碰 engine（没有占位可还）。
 * 5. 真实 pre-step：`next()` 抛错时**原始错误**必须是最终上抛的那个（端到端）。
 *
 * ## 不适用条件与已知边界
 * - 不改变归还的**语义**（仍只由 owner 归还、owner 不匹配仍不动状态）；
 * - 不重试归还：失败只告警，同回合可能暂时 busy（那是已有行为，见 /memory-lab status）。
 * - 本条不覆盖 `withdrawInjection`（宿主提交失败撤回首）路径。
 *
 * ## 定点变异自证
 * 去掉 try/catch（退回直接调用）→ 组 2/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { safeReleaseReservation } from '../src/index.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

test('P2-14 归还成功：released=true，原因与 owner 透传', () => {
  const calls = []
  const engine = { releaseInjectionReservation(...args) { calls.push(args) } }
  const out = safeReleaseReservation(engine, 's', 3, 'next-threw', { reservation: { owner: 'x' } })
  assert.deepEqual(out, { released: true, error: null })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['s', 3, 'next-threw', { reservation: { owner: 'x' } }])
})

test('P2-14 归还抛错：不得外抛，错误经返回值与 onError 同时可见', () => {
  const boom = new Error('lease-boom')
  const engine = { releaseInjectionReservation() { throw boom } }
  const seen = []
  const out = safeReleaseReservation(engine, 's', 1, 'not-presented', {}, (error) => seen.push(error))
  assert.equal(out.released, false, '失败必须如实报 false')
  assert.equal(out.error, boom, '原始错误必须原样带回（供告警）')
  assert.equal(seen.length, 1, 'onError 必须被调用，失败不能静默')
})

test('P2-14 告警口自己抛错也不得毒化控制流', () => {
  const engine = { releaseInjectionReservation() { throw new Error('lease-boom') } }
  let out
  assert.doesNotThrow(() => {
    out = safeReleaseReservation(engine, 's', 1, 'not-presented', {}, () => { throw new Error('warn-boom') })
  }, '告警口抛错必须被吞掉：它只负责上报')
  assert.equal(out.released, false)
  assert.equal(out.error.message, 'lease-boom')
})

test('P2-14 没有占位可还时直接返回，不触碰 engine', () => {
  let touched = 0
  const engine = { releaseInjectionReservation() { touched += 1 } }
  assert.deepEqual(safeReleaseReservation(null, 's', 1, 'x'), { released: false, error: null })
  assert.deepEqual(safeReleaseReservation(engine, undefined, 1, 'x'), { released: false, error: null })
  assert.deepEqual(safeReleaseReservation(engine, 's', null, 'x'), { released: false, error: null })
  assert.equal(touched, 0, '没有占位时不得调用引擎')
})

test('P2-14 端到端：next() 抛错时上抛的必须是宿主原始错误', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-p2-14-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const listeners = []
  const registered = []
  const stub = {
    logger: { warn() {}, info() {}, error() {} },
    on(event, handler, options) { listeners.push({ event, handler, prepend: options?.prepend === true }); return () => {} },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    inject(deps, callback) { return { dispose() {} } },
    commands: { register(definition) { registered.push(definition); return () => {} } },
  }
  try {
    const module = await import(pathToFileURL(path.join(process.cwd(), 'src', 'index.mjs')).href + '?t=' + Date.now())
    await module.apply(stub, { enabled: true, packMinScore: 0 })
    const session = createFakeSession({ id: 'p2-14-e2e' })
    session.pushUser('P2-14 端到端 ' + '材料'.repeat(120))
    await registered[0].handler({ rawInput: 'on', agent: { session } })
    const hook = listeners.find((row) => row.event === 'agent/pre-step' && row.prepend === true)
    assert.ok(hook !== undefined)
    const boom = new Error('host-next-boom')
    await assert.rejects(
      () => hook.handler(
        { agent: { session }, turn: 1, step: 1, signal: { aborted: false }, messages: [{ role: 'user', content: [{ type: 'text', text: 'P2-14' }] }] },
        async () => { throw boom },
      ),
      (error) => error === boom,
      'must 原样上抛宿主原始错误对象（不是租约层的替代异常）',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
