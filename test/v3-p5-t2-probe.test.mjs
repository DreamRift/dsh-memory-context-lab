/**
 * P5 T2：隔离探测的查询合同探针（假 MCP 子进程）。
 *
 * 判据：
 * - 基础冒烟通过后必须真的发起 cg read(query, k=2)，并记录 k/结果行字段；
 * - 结果行缺 state/reason 或空结果 → queryContract.passed=false，但**不推翻**基础冒烟；
 * - schemaDigest 来自工具面 + 版本 + 合同 ID，不含正文；
 * - 清理覆盖冒烟节点 + 查询探针节点（失败只记诊断）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { probeT2Isolated, schemaDigestOf } from '../src/v3/adapters/retrieval/t2-probe.mjs'
import { T2_SMOKE_QUERY_NODE_IDS } from '../src/v3/contracts/t2.mjs'
import { createFakeT2Child } from './helpers/fake-t2-child.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t2-query-probe-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function seedToken(root) {
  await writeFile(path.join(root, 't2-token'), 'mdcg1.recorder.abcdef.secret\n', 'utf8')
}

function queryRow(overrides = {}) {
  return { node: { id: 'v3r-0123456789abcdef' }, score: 0.4, state: 'DEFER', reason: '条件未确认', ...overrides }
}

test('查询合同探针通过：k=2、行含 node/score/state/reason，记录 schemaDigest', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const calls = []
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.17',
      spawnImpl: () => createFakeT2Child({
        serverVersion: '0.9.17',
        onTool: (args) => {
          calls.push(args)
          if (args.op === 'read' && typeof args.query === 'string') {
            return { body: { meta: {}, results: [queryRow()] } }
          }
          return undefined
        },
      }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, true, JSON.stringify(described))
    assert.equal(described.version, '0.9.17')
    assert.equal(described.queryContract.passed, true)
    assert.equal(described.queryContract.rows, 1)
    assert.equal(described.queryContract.fields.state, true)
    assert.equal(described.queryContract.fields.reason, true)
    assert.equal(described.queryContract.fields.score, true)
    assert.equal(described.queryContract.fields.nodeId, true)
    const queryCall = calls.find((args) => args.op === 'read' && typeof args.query === 'string')
    assert.ok(queryCall !== undefined)
    assert.equal(queryCall.k, 2, '必须按合同发 k')
    assert.equal(described.smokeCleanup, 'done')
    assert.match(described.schemaDigest, /^[0-9a-f]{16}$/)
    assert.equal(described.schemaDigest, schemaDigestOf(['cg', 'stg'], '0.9.17'))
    // 清理覆盖两类节点
    const forgetIds = calls.filter((args) => args.op === 'forget').map((args) => args.node_id)
    for (const id of T2_SMOKE_QUERY_NODE_IDS) assert.ok(forgetIds.includes(id), '必须清理 ' + id)
    await described.handle.close()
  })
})

test('查询合同失败：基础冒烟仍通过，queryContract 如实 false（能力面据此关 searchQuery）', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.17',
      spawnImpl: () => createFakeT2Child({
        serverVersion: '0.9.17',
        onTool: (args) => {
          if (args.op === 'read' && typeof args.query === 'string') {
            return { body: { meta: {}, results: [{ node: { id: 'v3r-0123456789abcdef' }, score: 0.4 }] } }
          }
          return undefined
        },
      }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, true)
    assert.equal(described.queryContract.passed, false)
    assert.match(described.queryContract.reason, /缺少 node\/score\/state/)
    await described.handle.close()
  })
})

test('查询合同空结果：passed=false 且 reason 说明行数', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.17',
      spawnImpl: () => createFakeT2Child({
        serverVersion: '0.9.17',
        onTool: (args) => (args.op === 'read' && typeof args.query === 'string'
          ? { body: { meta: {}, results: [] } }
          : undefined),
      }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, true)
    assert.equal(described.queryContract.passed, false)
    assert.match(described.queryContract.reason, /返回 0 行/)
    await described.handle.close()
  })
})
