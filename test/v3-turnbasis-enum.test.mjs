/**
 * B3-19（AUD50-07-01）+ P3-08（0.15.1 §3.3）turnBasis 枚举——**回落提示是死分支，已删除**。
 *
 * ## 缺陷（P3-08）
 * 旧实现让 `readSettings` 在收到非法 `turnBasis` 时回落 `human` 并挂一个
 * `turnBasisInvalid` 标记，status 再据此打印「配置值非法，已按 human 运行」。
 * 但**宿主 schema 早已拒绝非法值**（`Schema.union([const('human'), const('dsh')])`，
 * 加载期就抛），所以这条回落分支在生产路径上永远不可达：
 * - 它给出的是一条**不存在的运行时回落路径**的提示，读者会以为改配置文件能「带着提示跑起来」；
 * - 更糟的是它把「默认值」写死成 human——0.15.1 用户裁定默认改 `dsh` 后，这条死分支
 *   还会让「非法回落」与「真实默认」指向两个不同的值。
 * 根因是**判据放错了层**：枚举合法性由 schema 独占判定，入口不该再写第二套回落提示。
 *
 * ## 判据来源
 * - `src/index.mjs` 的 `Config.turnBasis` = `Schema.union([Schema.const('human'), Schema.const('dsh')])`；
 * - 非法值在 schema 层失败关闭（本节用例直接调用 schema 求证，不靠注释）；
 * - 入口只做「合法就取原值、不合法取默认」，不再产生任何诊断标记。
 *
 * ## 断言组
 * 1. schema 失败关闭：`Config({turnBasis: <非法>})` 必须抛（`'DSH'` / `'dsh '` / `''` / 42 / null）；
 * 2. 合法值原样通过且没有诊断标记（`turnBasisInvalid` 这个键**根本不存在**）；
 * 3. 非法值（模拟绕过 schema 的调用方）回落**当前默认**，仍然没有诊断标记——
 *    即「回落存在，但不再假装有运行时提示」；
 * 4. schema 枚举与客户端下拉选项逐值一致，且默认值两侧同源。
 *
 * ## 不适用条件与已知边界
 * - 本套件不证明宿主是否真的在加载期调用 schema（那是宿主契约，见 `v3-surface-contract`）；
 *   它只证明插件自己的 Config 定义确实拒绝非法值。
 * - 客户端 `DEFAULTS` 只是「宿主还没答」时的占位显示，不是写入真源；这里只核对它与 schema 同值。
 *
 * ## 定点变异自证（改回去必红）
 * - 把 `readSettings` 的非法分支改回「回落 'human' 并挂 turnBasisInvalid」→ 第 3 组红
 *   （断言 2/3 都会看到值为 'human' 或键存在）；
 * - 把 `Config` 的 union 放宽成 `Schema.string()` → 第 1 组红（非法值不再抛）。
 * 两次读数见台账 R21。
 *
 * ## 运行
 * `node --test test/v3-turnbasis-enum.test.mjs`（全量：`node scripts/test-all.mjs`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config, readSettings, SETTINGS_DEFAULTS } from '../src/index.mjs'
const INDEX = new URL('../src/index.mjs', import.meta.url)
const CLIENT = new URL('../src/client.js', import.meta.url)

const BAD = ['DSH', 'dsh ', '', 'auto', 42, null]

// schema 把 `null` 当「未提供」→ 取默认（与其它字段同口径，不算非法值）；
// 只有真的写了别的值才必须抛。readSettings 那一侧仍然把 null 当非法（它没有「未提供」的概念）。
const SCHEMA_BAD = BAD.filter((value) => value !== null)

test('P3-08 ①schema 失败关闭：human/dsh 之外的值在 Config 层直接抛', () => {
  // null = 「未提供」：volatile 字段解包后取默认（readSettings 负责解包，这里直接用它求证）。
  assert.equal(readSettings(Config({ turnBasis: null })).turnBasis, SETTINGS_DEFAULTS.turnBasis, 'null = 未提供，取默认')
  for (const bad of SCHEMA_BAD) {
    assert.throws(() => Config({ turnBasis: bad }), /turnBasis/, '非法值必须在 schema 层被拒：' + JSON.stringify(bad))
  }
  // 两个合法值必须都通过（不是「只有默认值能过」）。volatile 字段解包走 readSettings。
  assert.equal(readSettings(Config({ turnBasis: 'human' })).turnBasis, 'human')
  assert.equal(readSettings(Config({ turnBasis: 'dsh' })).turnBasis, 'dsh')
})

test('P3-08 ②合法值：原样返回，且不再有 turnBasisInvalid 诊断标记', () => {
  for (const good of ['human', 'dsh']) {
    const s = readSettings({ turnBasis: good })
    assert.equal(s.turnBasis, good)
    assert.equal(Object.hasOwn(s, 'turnBasisInvalid'), false, '死分支的标记键不得再出现（' + good + '）')
  }
  // 键未写：静默取默认
  assert.equal(readSettings().turnBasis, SETTINGS_DEFAULTS.turnBasis)
  assert.equal(readSettings({}).turnBasis, SETTINGS_DEFAULTS.turnBasis)
})

test('P3-08 ③非法值（绕过 schema）：回落当前默认，仍不产生诊断标记', () => {
  for (const bad of BAD) {
    const s = readSettings({ turnBasis: bad })
    assert.equal(s.turnBasis, SETTINGS_DEFAULTS.turnBasis, '非法值回落默认：' + JSON.stringify(bad))
    assert.equal(Object.hasOwn(s, 'turnBasisInvalid'), false, '回落不再挂提示（那是一条不可达路径）：' + JSON.stringify(bad))
  }
})

test('P3-08 ④交叉核对：schema 枚举 = 客户端下拉选项；默认值两侧同源', async () => {
  const indexSource = await readFile(INDEX, 'utf8')
  const clientSource = await readFile(CLIENT, 'utf8')
  assert.ok(indexSource.includes("Schema.union([Schema.const('human'), Schema.const('dsh')])"), 'schema 层枚举')
  const optionValues = [...clientSource.matchAll(/\{ value: '(\w+)', label: 'turnBasis\w+' \}/g)].map((m) => m[1])
  assert.deepEqual(optionValues, ['human', 'dsh'])
  // 入口默认（SETTINGS_DEFAULTS）与客户端占位默认必须同值，且都必须落在枚举里。
  const clientDefault = /turnBasis: '(\w+)'/.exec(clientSource)?.[1]
  assert.equal(clientDefault, SETTINGS_DEFAULTS.turnBasis, '客户端占位默认必须与宿主 SETTINGS_DEFAULTS 同值')
  assert.ok(['human', 'dsh'].includes(SETTINGS_DEFAULTS.turnBasis), '默认值必须落在枚举内')
  // 死分支必须真的删干净：源码里不得再有那条提示。
  assert.equal(indexSource.includes('配置值非法'), false, '回落提示属于死分支，应已删除')
})
