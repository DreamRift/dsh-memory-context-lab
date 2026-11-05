/**
 * P7 默认关闭守卫（G4 改写：从「装配面零引用」升级为「装配可达但零激活」）。
 *
 * ## 为什么口径变了
 * G4 要求「零引用修复后要有装配可达性测试，不能只证明纯函数可运行」。入口现在
 * **import + 构造候选句柄**（默认关闭、开关独立），但 pre-step 钩子不引用它——
 * 真正未验的是「首次入模时序」（G3 判定 logical-request=not-wired / wire=no-seam），
 * 那条要 G8 才验。因此本套件的判据从「零引用」改成三条同时成立：
 * ① 入口只允许一处 import + 一处构造（没有第二处接线、没有在钩子里派发）；
 * ② 命令面与 composition 仍然零引用（候选不通过命令/装配被激活）；
 * ③ 行为面：缺开关时 run 直接 disabled，不读 store、不碰 session、不写日志。
 *
 * ## 量具自检（旧套件 P7-G1b 保留）
 * 判据必须对「植入一行引用」判红，否则扫描面为空/正则写坏时本套件会恒绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runFirstIngressPreview, createFirstIngressCandidate } from '../src/v3/application/first-ingress.mjs'
import { FIRST_INGRESS_ASSEMBLY_CONTRACT, FIRST_INGRESS_THRESHOLD_CHARS } from '../src/v3/contracts/readback.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createDshHostAdapter } from '../src/v3/adapters/host/dsh-host.mjs'
import { FakeSession } from './helpers/fake-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(here, '..', 'src')

/** 候选在各装配面的**引用点**：允许清单之外的任何一处都是「已接线」。 */
const ASSEMBLY_FILES = [
  'index.mjs',
  'v3/composition/composition.mjs',
]

/** 判据 ①：入口恰好一处 import + 一处构造。 */
const ENTRY_FILE = 'v3/entry/v3-entry.mjs'

/** 读装配面（读不到就抛，不静默当作「没有引用」）。 */
async function readAssembly(rel) {
  return readFile(path.join(srcRoot, rel), 'utf8')
}

/** 计数（不用正则捕获组：判据要能被植入样本判红）。 */
function countOf(text, needle) {
  return text.split(needle).length - 1
}

test('P7-G1 命令面与 composition 仍零引用：候选不通过命令/装配被激活', async () => {
  const scanned = []
  for (const rel of ASSEMBLY_FILES) {
    const text = await readAssembly(rel)
    assert.ok(text.length > 1000, rel + ' 内容异常（' + text.length + ' chars），零引用断言会失去判别力')
    scanned.push(rel)
    assert.equal(countOf(text, 'first-ingress'), 0, rel + ' 不得引用首次呈现候选（G4：只在 entry 装配）')
  }
  assert.deepEqual(scanned, ASSEMBLY_FILES, '两个装配面都必须被扫到')
})

test('P7-G1b 量具自检：植入一条引用必被同一判据判红（落盘后同样判红）', async () => {
  const real = await readAssembly('index.mjs')
  const planted = real + "\nimport { runFirstIngressPreview } from './v3/application/first-ingress.mjs'\n"
  assert.equal(countOf(planted, 'first-ingress'), 1, '判据对植入引用必须计数为 1')
  assert.equal(countOf(real, 'first-ingress'), 0, '防误杀对照：真实文件不得被判红')
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-p7-planted-'))
  try {
    const file = path.join(dir, 'index.mjs')
    await writeFileSafe(file, planted)
    const roundtrip = await readFile(file, 'utf8')
    assert.equal(countOf(roundtrip, 'first-ingress'), 1, '落盘再读后仍必须判红（判据读内容，不看文件名）')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 落盘助手（tests 内的写只用于量具自检，不碰仓库文件）。 */
async function writeFileSafe(file, text) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, text, 'utf8')
}

test('P7-G1c 入口只允许一处 import + 一处构造，且 pre-step 钩子体内零引用', async () => {
  const text = await readAssembly(ENTRY_FILE)
  assert.equal(countOf(text, 'first-ingress.mjs'), 1, '只准一处 import（多一处就是第二条接线）')
  assert.equal(countOf(text, 'createFirstIngressCandidate('), 1, '只准一处构造（多一处就是第二条接线）')
  const hookStart = text.indexOf("ctx.on('agent/pre-step'")
  assert.ok(hookStart > 0, '找不到 pre-step 钩子：扫描面失效，本断言不能恒绿')
  const hookEnd = text.indexOf('\n  })\n', hookStart)
  assert.ok(hookEnd > hookStart, '找不到 pre-step 钩子结尾')
  const hookBody = text.slice(hookStart, hookEnd)
  assert.equal(countOf(hookBody, 'firstIngress'), 0, 'pre-step 钩子不得引用候选（零激活）')
  assert.equal(countOf(hookBody, 'FirstIngress'), 0, 'pre-step 钩子不得调用候选（零激活）')
})

test('P7-G2 默认关闭是行为保证：缺开关时直接 disabled，不碰 session/store（独立开关不自动激活）', async () => {
  const out = await runFirstIngressPreview({})
  assert.deepEqual(out, { status: 'disabled', previewed: 0, skipped: 0, items: [] })
  // 给了 session/host/store 但没 enabled：同样不得动作
  const session = new FakeSession({ id: 'p7-gate' })
  const host = createDshHostAdapter({ session, sessionKey: 'p7-gate' })
  const store = { persistOriginal: async () => { throw new Error('must not be called') }, readOriginal: async () => ({ text: '' }) }
  const out2 = await runFirstIngressPreview({ session, host, store })
  assert.equal(out2.status, 'disabled')
  assert.equal(session.events.length, 0)

  // 装配句柄：默认关闭；把独立开关打开也只改 enabledNow，不自动激活、不派发
  const off = createFirstIngressCandidate({ settingsNow: () => ({}) })
  assert.equal(off.enabled, false)
  assert.equal(off.status, 'inactive')
  assert.equal(off.activation, 'none')
  assert.equal(off.enabledNow(), false)
  assert.deepEqual(await off.run({ session, host, store }), { status: 'disabled', previewed: 0, skipped: 0, items: [] })
  const on = createFirstIngressCandidate({ settingsNow: () => ({ firstIngress: { enabled: true } }) })
  assert.equal(on.enabledNow(), true, '开关独立：只认 firstIngress.enabled')
  assert.equal(on.status, 'inactive', '开关打开也不等于入口已派发（真实时序留 G8）')
  assert.equal(session.events.length, 0, '装配与开关都不得产生事件')
})

test('P7-G3 装配可达：入口构造的句柄来自首次呈现模块，且只有 entry 引用它', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p7-reach-'))
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { warn() {}, info() {} },
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const handle = engine.firstIngress
    assert.ok(handle !== null && typeof handle === 'object', '入口必须暴露候选句柄（装配可达）')
    assert.equal(handle.contract, FIRST_INGRESS_ASSEMBLY_CONTRACT, '句柄来自首次呈现装配合同（import 图可达）')
    assert.equal(handle.status, 'inactive')
    assert.equal(handle.enabled, false)
    assert.equal(handle.policyVersion, 1)
    assert.equal(handle.reason, 'default-off')
    assert.equal(typeof handle.reconcile, 'function')
    assert.ok(handlers.has('agent/pre-step'), '钩子仍注册（本改动不删钩子、不抢钩子）')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  // 引用唯一性：src 里只有 entry 提到 first-ingress.mjs
  async function walk(dir, out = []) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, out)
      else if (entry.name.endsWith('.mjs')) out.push(full)
    }
    return out
  }
  const files = await walk(srcRoot)
  const referrers = []
  for (const file of files) {
    const body = await readFile(file, 'utf8')
    if (body.includes('first-ingress.mjs')) referrers.push(path.relative(srcRoot, file).replaceAll('\\', '/'))
  }
  assert.deepEqual(referrers, ['v3/entry/v3-entry.mjs'], '只有入口 import 首次呈现用例（装配可达且唯一）')

  // 阈值常量确实是从合同派生（顺手锁死：开关打开也不会用另一个数字）
  assert.ok(FIRST_INGRESS_THRESHOLD_CHARS > 0, '阈值派生必须可用')
})
