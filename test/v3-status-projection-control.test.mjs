/**
 * AUD-01 守卫：会话级 `gate` 覆盖必须穿过「宿主投影 → viewSchema → 客户端」整条链。
 *
 * ## 缺陷（2026-10-28 审计，AUD-01 P1）
 * 用户在 composer 弹层把「按步归档闸门」设成 5 后，`control.json` 里确实有
 * `{"overrides":{"gate":5}}`，归档也真实按 5% 生效；但弹层输入框永远空白
 * （占位符「跟随全局」），因为宿主投影的 `CONTROL_KEYS` 被写死成 `['limit']`，
 * 把 `gate` 静默丢掉；而 `viewSchema` 又要求 `control.overrides` 恰好 1 个键，
 * 补上 gate 也过不了校验。同一组键在 domain / 投影 / client 各写一份，没有交叉校验。
 *
 * ## 判据来源
 * 审计文档 `AUD-01-会话闸门覆盖不可见-20261028.md` §5 / §8：根因在双份常量 +
 * 钉死的键数；修复口径 = 投影与 `SESSION_OVERRIDE_KEYS` 同源（方案 A）。
 *
 * ## 断言组
 * 1. 真实入口 + 临时 `DSH_HOME`：`/memory-lab set gate 5` 后，投影 view 里
 *    `control.overrides.gate === 5`、`limit === null`，且 `viewSchema.parse` 通过；
 *    `control.json` 与 view 一致（三处一致的第一半）。
 * 2. `/memory-lab unset gate` 后 view 回落 null（覆盖可撤）。
 * 3. 交叉常量：投影的 `PROJECTION_CONTROL_KEYS` **就是** domain 的
 *    `SESSION_OVERRIDE_KEYS`（同一份冻结数组），客户端的 `SESSION_OVERRIDE_FIELDS`
 *    键集与之逐键相等——三处任一处再写白名单都会红。
 * 4. schema 仍严格：少一个键 / 多一个键都必须抛错（不是「放宽到什么都收」）。
 * 5. `STATUS_PROJECTION_VERSION` 已提升（旧检查点被宿主丢弃重折）。
 * 6. `/memory-lab status` 的「生效回注设置」按会话覆盖显示闸门（AUD-04 同族）。
 *
 * ## 不适用条件与已知边界
 * - 不覆盖真实浏览器渲染：输入框回显由 `v3-client-chip` 的独立用例钉住；本文件只证明
 *   **投影把值交到了客户端手里**。
 * - 不覆盖宿主自家 `dsh-session-projection-cache` 的版本丢弃行为（那是宿主实现，
 *   本插件只负责递增 `stateVersion`）。
 * - 本守卫绿 ≠ 客户端 bundle 已重新装配；后者需重启 DSH。
 *
 * ## 定点变异自证（2026-10-29 实测）
 * 把投影改回 `const CONTROL_KEYS = Object.freeze(['limit'])`（并去掉同源导出）→
 * 本文件第 1/3 组红；恢复后全绿。
 *
 * ## 运行
 * `node --test-force-exit test/v3-status-projection-control.test.mjs`（已接 npm test）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PROJECTION_CONTROL_KEYS,
  STATUS_PROJECTION_KEY,
  STATUS_PROJECTION_VERSION,
  createStatusProjectionDefinition,
} from '../src/v3/adapters/host/status-projection.mjs'
import { SESSION_OVERRIDE_KEYS } from '../src/v3/domain/session/session-control.mjs'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(SRC, '..')
const ENTRY = path.join(ROOT, 'src', 'index.mjs')
const CLIENT = path.join(ROOT, 'src', 'client.js')

/** 最小宿主：命令注册 + sessionProjections 可选注入（与真实入口的可选注入同形）。 */
function makeCtx() {
  const registered = []
  const projections = []
  const ctx = {
    on() { return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
    commands: { register(row) { registered.push(row); return () => {} } },
    inject(deps, callback) {
      if (typeof callback === 'function' && deps.includes('sessionProjections')) {
        callback({ sessionProjections: { register(definition) { projections.push(definition); return () => {} } } })
      }
      return { dispose() {} }
    },
  }
  return { ctx, commands: registered, projections }
}

/** 客户端半：走真实 factory，取导出的覆盖字段定义。 */
async function loadClientFields() {
  const registered = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(entry) { registered.push(entry) } } }
  try {
    await import(pathToFileURL(CLIENT).href + '?t=' + Date.now())
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(registered.length, 1, '浏览器半必须恰好自注册一次')
  return registered[0].factory(() => ({})).SESSION_OVERRIDE_FIELDS
}

test('AUD-01：会话级 gate 覆盖穿过投影到客户端视图（真实入口 + 真实 control.json）', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-aud01-'))
  const previousHome = process.env.DSH_HOME
  const previousT2 = process.env.MEMORY_LAB_T2
  process.env.DSH_HOME = home
  process.env.MEMORY_LAB_T2 = '0'
  try {
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    const { ctx, commands, projections } = makeCtx()
    await module.apply(ctx, {})
    assert.equal(commands.length, 1, '命令面必须注册（set/unset 是写入端）')
    assert.equal(projections.length, 1, '状态投影必须注册')
    const definition = projections[0]
    assert.equal(definition.key, STATUS_PROJECTION_KEY)

    const sessionId = 's-aud01'
    const run = (line) => commands[0].handler({ agent: { session: { id: sessionId } }, rawInput: line })
    const view = () => {
      const state = definition.apply(definition.init({ id: sessionId }), { seq: 1 })
      return definition.wire.view(state)
    }

    // 1) 写入端：会话级闸门 5。
    const set = await run('set gate 5')
    assert.equal(set.kind, 'success', set.text)
    const controlPath = path.join(home, '.memory-context-lab', 'v3', 'sessions', sessionId, 'control.json')
    const onDisk = JSON.parse(await readFile(controlPath, 'utf8'))
    assert.equal(onDisk.overrides.gate, 5, '磁盘上的覆盖必须真的写进去了（写入端本来就好）')

    // 2) 读取端（本缺陷）：投影必须把 gate 交出来，且 schema 接受。
    const projected = view()
    assert.equal(projected.control.overrides.gate, 5, '投影丢了 gate 就是 AUD-01 本体：客户端只能显示「跟随全局」')
    assert.equal(projected.control.overrides.limit, null, '未覆盖项仍必须是 null（不是 0、不是缺键）')
    assert.deepEqual(Object.keys(projected.control.overrides).sort(), ['gate', 'limit'], '键集合必须与真源一致')
    assert.doesNotThrow(() => definition.wire.viewSchema.parse(projected), 'viewSchema 必须接受两键形状')
    for (const key of SESSION_OVERRIDE_KEYS) {
      assert.equal(projected.control.overrides[key], onDisk.overrides[key] ?? null,
        '磁盘与投影必须一致（三处一致的第一半）：' + key)
    }

    // 3) limit 与 gate 同时覆盖时互不覆盖。
    assert.equal((await run('set limit 3')).kind, 'success')
    const both = view()
    assert.equal(both.control.overrides.gate, 5)
    assert.equal(both.control.overrides.limit, 3)
    assert.doesNotThrow(() => definition.wire.viewSchema.parse(both))

    // 4) 清除覆盖 → 回显回落 null（「清除」也必须可看）。
    assert.equal((await run('unset gate')).kind, 'success')
    const cleared = view()
    assert.equal(cleared.control.overrides.gate, null, 'unset 后投影必须回到 null，而不是留着旧值')
    assert.equal(cleared.control.overrides.limit, 3, 'unset gate 不得连带清掉 limit')
    assert.doesNotThrow(() => definition.wire.viewSchema.parse(cleared))

    // 5) 状态行「生效回注设置」必须显示会话覆盖的闸门，而不是恒 20%（AUD-04 同族）。
    assert.equal((await run('set gate 5')).kind, 'success')
    const status = await run('status')
    assert.equal(status.kind, 'success')
    assert.match(status.text, /按步闸门 5%/, '合并后的设置字段名是 gate；读 coolingGate 会恒回落 20%')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousT2 === undefined) delete process.env.MEMORY_LAB_T2
    else process.env.MEMORY_LAB_T2 = previousT2
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('交叉常量：投影 / domain / 客户端三处键集同源（防第三次重演）', async () => {
  assert.equal(PROJECTION_CONTROL_KEYS, SESSION_OVERRIDE_KEYS,
    '投影必须直接复用 domain 的冻结数组；再写一份 [\'limit\'] 白名单就会红')
  assert.deepEqual([...PROJECTION_CONTROL_KEYS], ['limit', 'gate'])
  const clientFields = await loadClientFields()
  assert.deepEqual(clientFields.map((field) => field.key), [...SESSION_OVERRIDE_KEYS],
    '客户端读的键必须与真源逐键相等；否则「写进去的值读不回来」会重演')
  // 静态面：投影文件里不得再出现硬编码的 limit 白名单。
  const source = await readFile(path.join(ROOT, 'src', 'v3', 'adapters', 'host', 'status-projection.mjs'), 'utf8')
  assert.equal(/Object\.freeze\(\['limit'\]\)/.test(source), false, '白名单常量不得复活')
  assert.match(source, /SESSION_OVERRIDE_KEYS/, '投影必须从 domain 导入键集')
})

test('schema 仍严格：overrides 少键/多键都必须抛错（不是放宽成什么都收）', () => {
  const definition = createStatusProjectionDefinition({ statusOf: () => ({ state: 'absent' }) })
  const view = definition.wire.view(definition.init({ id: 's-shape' }))
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(view))
  const missing = { ...view, control: { ...view.control, overrides: { limit: null } } }
  assert.throws(() => definition.wire.viewSchema.parse(missing), /view\.control\.overrides/)
  const extra = { ...view, control: { ...view.control, overrides: { limit: null, gate: null, extra: 1 } } }
  assert.throws(() => definition.wire.viewSchema.parse(extra), /view\.control\.overrides/)
  const wrongType = { ...view, control: { ...view.control, overrides: { limit: null, gate: '5' } } }
  assert.throws(() => definition.wire.viewSchema.parse(wrongType), /overrides\.gate/)
  // 坏形状的默认视图仍然合法：客户端在「宿主还没回过值」时不能崩。
  const plain = createStatusProjectionDefinition({ statusOf: () => ({ state: 'absent', control: { overrides: { gate: 5 } } }) })
  const partial = plain.wire.view(plain.init({ id: 's-partial' }))
  assert.equal(partial.control.overrides.gate, 5)
  assert.equal(partial.control.overrides.limit, null)
  assert.doesNotThrow(() => plain.wire.viewSchema.parse(partial))
})

test('STATUS_PROJECTION_VERSION 已提升：旧检查点必须被宿主丢弃重折', () => {
  assert.equal(STATUS_PROJECTION_VERSION, 2,
    'view 形状变了（overrides 多一个键）；不升版本，旧检查点会带着一条键的 state 冷恢复')
})
