/**
 * I5 诊断投影 + P3-08 死分支收口（0.15.1 §3.3）。
 *
 * ## 背景与两次结论（如实留痕）
 * I5 合同（`docs/dev-上下文缓存改进/证据/I5-组件界面清单与诊断投影合同.md`）按 accepted
 * 实现了 `diagnosticLines`：读 `status.diagnostics` 的诊断包，渲染八状态词表、四层覆盖度、
 * usage 三门槛、Native 文本、错误 code 脱敏。当时即写明「未接真实宿主 UI（需 I6）」。
 *
 * 0.15.1 独立排查（P3-08）核到的**事实**是：`statusViewSchema` 的字段集合里**没有**
 * `diagnostics`，入口 `statusText` 也不产出该键——也就是说，这条渲染路径在真实投影上
 * 永远拿到 `undefined`，是**死分支**。
 *
 * ## 本条怎么处置（两种合法修法里选了「保持未接线 + 诚实标注」）
 * 台账允许「删死分支」或「接通投影」二选一。这里选**不接线**，理由是可验证的：
 * 1. 诊断包需要的四个事实（公共状态、四层覆盖度、usage 门槛、Native 原文）在今天都
 *    **没有生产方**：`observation-capability.mjs` 只声明能力状态，`readUsageSummary` 给的是
 *    token 汇总而不是 `providerVerified/requestPaired/inputIncludesCache` 三门槛，
 *    Native 原文来自 dsh-ops 的 PTC 结果面（本仓库无该适配器）。**没有真值来源，
 *    硬凑一个 diagnostics 键就是拿伪造事实喂养 UI**——那正是 I5 合同 §2.3 明令禁止的方向。
 * 2. 因此本套件**不再声称**「诊断投影已接线」，只钉住三件事：
 *    ① 渲染函数本身仍满足 I5 的显示纪律（八状态封闭词表、未知输入失败关闭、敏感信息不回显）；
 *    ② 未接线这件事在**观察面可见**（`diagnostics` 缺键 = 不出诊断行，绝不伪造 ready/正常）；
 *    ③ 一旦将来有人把它接进投影，本套件的最小门仍在（不会被顺手删掉）。
 *
 * ## 断言组（对照 I5 合同 §5 的 14 项）
 * 1. 八个合法公共状态 → 用既有词表翻译；词表外值 → 未知，并保留 code；
 * 2. 四层 coverage 必须**按固定顺序**逐层出现，空分母显示「不可计算」而不是 0%；
 * 3. usage 三门槛未齐 → 只出「不可计算」，绝不出命中率百分数；
 * 4. Native 文本原样呈现但**先脱敏**（凭据/家目录不出现）；非文本 → 未知；
 * 5. 坏形状 / 未知字段 → 未知（失败关闭），不默认成功；
 * 6. 投影里没有 `diagnostics` 键时 → **一行诊断都不出**（这正是当前真实状态）。
 *
 * ## 不适用条件与已知边界
 * - 这些用例直接驱动客户端工厂里的渲染函数，**不经过宿主 UI**，因此不证明接线状态；
 * - 客户端的 `diagnostics` 缺键断言只证明「未接线的现状被如实呈现」，不证明将来接线正确；
 * - 本套件不覆盖 X11/X12/X14（旧 handle 复用、invoke 调用计数在展示层不可验证，需 I6）。
 *
 * ## 定点变异自证（改回去必红）
 * 把客户端 **接上** 一个 diagnostics 键（哪怕只是占位 `{}`）→ 第 6 组红（多出诊断行）；
 * 把未知状态渲染成「正常」→ 第 1 组红。
 *
 * ## 运行
 * `node --test test/v3-client-i5-diagnostics.test.mjs`
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCL_STATUS_VOCABULARY } from '../src/v3/contracts/status-vocabulary.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'src', 'client.js')
const STATUSES = MCL_STATUS_VOCABULARY
const EXPECTED_STATUS_LABELS = { ok: '正常', partial: '部分', unknown: '未知', unavailable: '不可用', stale: '已过期', conflict: '冲突', failed: '失败', rejected: '已拒绝' }

async function setup(options = {}) {
  const registered = []
  const before = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => registered.push(entry) } }
  try { await import(pathToFileURL(CLIENT).href + '?i5=' + Math.random()) }
  finally { if (before === undefined) delete globalThis.window; else globalThis.window = before }
  let index = 0
  const hooks = []
  let renderAgain
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { const p = props ?? {}; const kids = children.length === 1 ? children[0] : children; return typeof type === 'function' ? type({ ...p, children: kids }) : { type, props: p, children: kids } },
    useState(initial) { const i = index++; if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (v) => { hooks[i].value = typeof v === 'function' ? v(hooks[i].value) : v; renderAgain?.() }] },
    useEffect() { index++ },
  }
  const module = registered[0].factory((name) => name === 'react' ? React : { Button() {}, Switch() {} })
  const slots = []
  let localeData
  const ctx = { effect(fn) { fn() }, locale: { register(_ns, dict) { localeData = dict } }, slots: { inject(_n, fn) { fn() }, register(registration, component) { slots.push({ registration, component }) } }, inject() {} }
  module.apply(ctx)
  const chip = slots.find((x) => x.registration.name === module.CHIP_SLOT).component
  let tree
  const status = { state: 'ready', ingested: 0, searchable: 0, archived: 0, injected: 0, attempted: 0 }
  const source = await readFile(CLIENT, 'utf8')
  // 动态 label（如 t(field.label)）不在字面调用提取范围内，直接用客户端注册的完整 zh 字典。
  const vocabularyBlock = source.match(/const MCL_STATUS_LABELS = Object.freeze\(\{([\s\S]*?)\}\)/)?.[1]
  assert.ok(vocabularyBlock, '必须找到客户端公共状态标签表')
  const clientStatusKeys = [...vocabularyBlock.matchAll(/([a-z]+):\s*'/g)].map((m) => m[1]).sort()
  assert.deepEqual(clientStatusKeys, [...MCL_STATUS_VOCABULARY].sort(), '客户端状态标签键必须与 canonical 封闭词表集合一致')
  const labels = { ...localeData.zh }
  if (typeof options.omitKey === 'string') delete labels[options.omitKey]
  const props = { t: (k, v) => { if (!Object.hasOwn(labels, k)) throw new Error('测试替身缺少 label key: ' + k); let text = labels[k]; for (const [a, b] of Object.entries(v ?? {})) text = text.replace('{' + a + '}', String(b)); return text }, useProjection: () => status, sessionId: 's' }
  const render = () => { index = 0; tree = chip(props) }
  renderAgain = render
  render()
  const walk = (n, out = []) => { if (n == null) return out; if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return out } if (typeof n === 'object') { if (typeof n.children === 'string' || typeof n.children === 'number') out.push(String(n.children)); walk(n.children, out) } return out }
  const show = (diagnostics, searchable) => {
    if (diagnostics === undefined) delete status.diagnostics
    else status.diagnostics = diagnostics
    status.searchable = searchable
    render()
    let pop = find(tree, (n) => n.props?.className === 'mcl-pop')
    if (!pop) { const button = find(tree, (n) => n.type === 'button' && n.props.className === 'mcl-chip'); button.props.onClick(); render(); pop = find(tree, (n) => n.props?.className === 'mcl-pop') }
    return walk(pop).join(' | ')
  }
  return { show, module, slots }
}
function find(n, p) { if (!n) return null; if (Array.isArray(n)) { for (const x of n) { const r = find(x, p); if (r) return r } return null } if (typeof n !== 'object') return null; if (p(n)) return n; return find(n.children, p) || find(n.props?.children, p) }
const cov = () => ['plugin-surface', 'logical-request', 'wire', 'provider-usage'].map((layer) => ({ layer, state: 'partial', observedRows: 1, totalRows: 2, ratio: 0.5 }))

test('①八个状态译为封闭词表，外值失败关闭且保留 code', async () => {
  const x = await setup()
  for (const status of STATUSES) assert.match(x.show({ status, code: 'EBOOM' }), /诊断状态：/)
  const out = x.show({ status: 'ready', code: 'EBOOM' })
  assert.match(out, /诊断状态：未知/)
  assert.match(out, /code: EBOOM/)
})

test('②searchable=0 显示确切零；null/undefined/负数/小数显示未知', async () => {
  const x = await setup()
  assert.match(x.show({ status: 'ok' }, 0), /可检索 0 条/)
  for (const v of [null, undefined, -1, 1.2]) {
    const out = x.show({ status: 'ok' }, v)
    assert.match(out, /可检索 未知/)
    assert.doesNotMatch(out, /可检索 0 条/)
  }
})

test('③四层 coverage 固定顺序，空分母不汇总、不写 0%', async () => {
  const x = await setup()
  const rows = cov()
  rows[2] = { ...rows[2], totalRows: 0, ratio: null }
  const out = x.show({ status: 'unknown', coverage: rows })
  let prev = -1
  for (const layer of ['plugin-surface', 'logical-request', 'wire', 'provider-usage']) {
    const at = out.indexOf(layer)
    assert.ok(at > prev, layer)
    prev = at
  }
  assert.match(out, /不可计算/)
  assert.doesNotMatch(out, /· 0%|总命中率/)
})

test('④usage 三门槛未齐：只出「不可计算」，绝不出命中率百分比', async () => {
  const x = await setup()
  for (const usage of [{}, { inputTokens: -1 }, { request: null, requestPaired: false }, { wire: 'no-seam' }, { providerVerified: true, requestPaired: true, inputIncludesCache: true }]) {
    const out = x.show({ status: 'unknown', usage })
    assert.doesNotMatch(out, /命中率\s*[:：]\s*\d+%|provider hit rate/i)
  }
  assert.match(x.show({ status: 'unknown', usage: { request: null, requestPaired: false } }), /unpaired/)
})

test('⑤Native 文本先脱敏再呈现；非文本 → 未知', async () => {
  const x = await setup()
  const out = x.show({ status: 'unknown', native: '错误码 E_NATIVE api_key=SECRET-123 路径 C:\\Users\\alice\\a.txt' })
  assert.match(out, /原生文本：错误码 E_NATIVE/)
  assert.doesNotMatch(out, /SECRET-123|alice/)
  assert.match(x.show({ status: 'unknown', native: { kind: 'ok' } }), /未知/)
})

test('⑥坏形状/未知字段失败关闭；错误 code 过滤凭据', async () => {
  const x = await setup()
  for (const d of [null, [], { status: 'ready' }, { status: 'ok', extra: 1 }]) {
    const out = x.show(d)
    assert.match(out, /未知/)
    assert.doesNotMatch(out, /诊断状态：正常/)
  }
  const out = x.show({ status: 'failed', code: 'API_KEY=leak' })
  assert.match(out, /EUNKNOWN/)
  assert.doesNotMatch(out, /leak/)
})

test('⑦未接线现状：投影没有 diagnostics 键时一行诊断都不出（不伪造 ready/正常）', async () => {
  const x = await setup()
  const out = x.show(undefined)
  assert.doesNotMatch(out, /诊断状态|诊断不可判定/)
  // 但 chip 主体仍在：缺诊断不等于 chip 崩掉
  assert.ok(out.length > 0, '弹层必须照常渲染')
})

test('⑧状态词表标签与 canonical 封闭词表逐项一致（客户端不得自建状态词）', async () => {
  const x = await setup()
  for (const s of STATUSES) assert.ok(x.show({ status: s }).includes('诊断状态：' + EXPECTED_STATUS_LABELS[s]), s + ' 必须显示对应中文状态')
  assert.match(x.show({ status: 'stale' }), /重新读取/)
  assert.match(x.show({ status: 'conflict' }), /不自动重试或覆盖/)
})

test('⑨保持旧 slot/key/commands 与恒定工具集，不增动态 schema', async () => {
  const x = await setup()
  assert.equal(x.module.CHIP_SLOT, 'conversation.input.left')
  assert.equal(x.module.PROJECTION_KEY, 'memoryContextLabStatus')
  assert.deepEqual(x.module.inject, ['slots', 'locale', 'remote', 'remote.commands'])
  assert.equal(x.slots.filter((s) => s.registration.name === 'conversation.input.left').length, 1)
})

test('⑩测试替身缺少诊断 label key 必须明确失败（替身遗漏不会被静默吞掉）', async () => {
  const x = await setup({ omitKey: 'diagStatus' })
  assert.throws(() => x.show({ status: 'ok' }), /测试替身缺少 label key: diagStatus/)
})
