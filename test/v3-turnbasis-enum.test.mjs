/**
 * B3-19（AUD50-07-01）turnBasis 枚举——Config 层 union(const) 拒绝非法值；
 * readSettings 对手改配置的非法回落带 turnBasisInvalid 标记（status 可见）；
 * schema 枚举值与客户端下拉选项交叉核对。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readSettings } from '../src/index.mjs'
const INDEX = new URL('../src/index.mjs', import.meta.url)
const CLIENT = new URL('../src/client.js', import.meta.url)

test('B3-19 readSettings：非法值回落 human 且标记可见；合法值无标记', () => {
  for (const bad of ['DSH', 'dsh ', '', 'auto', 42, null]) {
    const s = readSettings({ turnBasis: bad })
    assert.equal(s.turnBasis, 'human', '非法值回落 human：' + JSON.stringify(bad))
    assert.equal(s.turnBasisInvalid, true, '回落必须可见：' + JSON.stringify(bad))
  }
  const ok = readSettings({ turnBasis: 'dsh' })
  assert.equal(ok.turnBasis, 'dsh')
  assert.equal(ok.turnBasisInvalid, undefined)
  const okHuman = readSettings({ turnBasis: 'human' })
  assert.equal(okHuman.turnBasisInvalid, undefined)
  // 键未写/无配置：静默取默认，不算非法（全新安装不得显示「配置值非法」）
  assert.equal(readSettings().turnBasisInvalid, undefined)
  assert.equal(readSettings({}).turnBasisInvalid, undefined)
})

test('B3-19 交叉核对：schema 枚举与客户端下拉选项一致；status 提示存在', async () => {
  const indexSource = await readFile(INDEX, 'utf8')
  const clientSource = await readFile(CLIENT, 'utf8')
  assert.ok(indexSource.includes("Schema.union([Schema.const('human'), Schema.const('dsh')])"), 'schema 层枚举')
  // 客户端下拉选项只有 human/dsh（与 schema 同一封闭集）
  const optionValues = [...clientSource.matchAll(/\{ value: '(\w+)', label: 'turnBasis\w+' \}/g)].map((m) => m[1])
  assert.deepEqual(optionValues, ['human', 'dsh'])
  // 回落提示真的接到 status 行上
  assert.ok(indexSource.includes('配置值非法，已按 human 运行'))
})
