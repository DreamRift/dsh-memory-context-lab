/**
 * P6 能力关闭守卫。
 *
 * 缺陷：合同/候选证据容易被误读成高级路径已启用或已验证。
 * 判据来源：docs/dev-0.15.0/开发流程.md P6 验收与 P5 能力矩阵。
 * 断言组：P6 高级能力关闭、contract/candidate 分层、图/时间路径不伪造可达性。
 * 不适用：本守卫不证明搜索质量、增益、真实宿主集成或正式灵枢可用性。
 * 定点变异自证（2026-11-01，隔离工作树）：
 *   1) 遗留变异 multiPathRecall=on → 3/3 失败（'on' !== 'off'）；
 *   2) 临时把 0.9.17 status candidate→tested → candidate 用例失败（actual 'tested'）；
 *   3) 两次复原后 3/3 通过，源码与 HEAD 0 差异。
 * 运行：node --test-force-exit test/v3-p6-capability-guard.test.mjs（exit 0；3 pass / 0 fail）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { negotiateMemoryProvider } from '../src/v3/contracts/capabilities.mjs'
import { t2CapabilitiesOf, t2ContractOf } from '../src/v3/contracts/t2-contract.mjs'

const P6_FEATURES = ['queryExcerpt', 'multiPathRecall', 'taskFactMirror']

function assertP6Closed(report, label) {
  for (const feature of P6_FEATURES) {
    assert.equal(report.features[feature]?.state, 'off', label + ': ' + feature + ' 必须关闭')
    assert.ok(typeof report.features[feature]?.reason === 'string' && report.features[feature].reason.length > 0, label + ': ' + feature + ' 必须有关闭理由')
  }
  assert.equal(report.packExternal.state, 'off', label + ': packExternal 必须关闭')
  for (const feature of [...P6_FEATURES, 'packExternal']) {
    assert.ok(
      report.downgraded.some((entry) => entry.feature === feature),
      label + ': ' + feature + ' 必须出现在降级清单，不能只在内部静默关闭',
    )
  }
}

test('P6：0.9.10 tested 只证明基础隔离冒烟，read-query 仍为 contract，高级路径全部关闭', () => {
  const report = t2CapabilitiesOf({
    version: '0.9.10',
    tools: ['cg', 'stg'],
    smokePassed: true,
  })
  assert.equal(t2ContractOf('0.9.10').status, 'tested')
  assert.equal(report.features.basicMirror.state, 'on')
  assert.equal(report.features.searchQuery.state, 'contract')
  assertP6Closed(report, '0.9.10')
})

test('P6：0.9.17 candidate 即使合同探针通过也不默认启用，高级路径不被提升', () => {
  const report = t2CapabilitiesOf({
    version: '0.9.17',
    tools: ['cg', 'stg'],
    smokePassed: true,
    queryContract: { passed: true, rows: 2 },
  })
  assert.equal(t2ContractOf('0.9.17').status, 'candidate')
  assert.equal(report.features.basicMirror.state, 'on', '合同报告可描述基础能力，但不等于默认启用')
  assert.equal(report.features.searchQuery.state, 'on', '这里只是查询合同字段已探针，不代表 P6 增益已验证')
  assertP6Closed(report, '0.9.17')

  const decision = negotiateMemoryProvider({
    name: '@furongjun1999/dsh-memory',
    version: '0.9.17',
    tools: ['cg', 'stg'],
    smokePassed: true,
    isolated: true,
    queryContract: { passed: true, rows: 2 },
  })
  assert.equal(decision.tier, 'T1')
  assert.match(decision.reason, /候选版本.*未默认启用/)
})

test('P6：未知版本失败关闭，图/时间等路径只能落在 multiPathRecall=off', () => {
  const report = t2CapabilitiesOf({
    version: '9.9.9',
    tools: ['cg', 'stg'],
    smokePassed: true,
    queryContract: { passed: true, rows: 2 },
  })
  assert.equal(report.features.basicMirror.state, 'off')
  assert.equal(report.features.searchQuery.state, 'off')
  assertP6Closed(report, 'unknown')
  assert.match(report.features.multiPathRecall.reason, /BM25/)
  assert.match(report.features.multiPathRecall.reason, /多路召回未启用/)
  assert.deepEqual(
    Object.keys(report.features).sort(),
    ['basicMirror', 'multiPathRecall', 'queryExcerpt', 'searchQuery', 'taskFactMirror'].sort(),
    '能力报告不得凭空增加图/时间等未登记路径',
  )
})
