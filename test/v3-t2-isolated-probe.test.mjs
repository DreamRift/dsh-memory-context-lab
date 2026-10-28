/**
 * T2 隔离探测测试（beta.35，假 MCP 子进程）。
 *
 * 判据（T2 隔离设计 §4）：
 * - 探测成功必须完成 initialize / tools/list / 写 / 读回四步，且交回已握手的 handle；
 * - 缺 cg、写失败、读回无标记都必须 smokePassed=false 并带原因（由 negotiate 回 T1）；
 * - 失败路径关闭子进程，不泄漏；
 * - 令牌只落在隔离根（本测试预置 token 文件，避免签发命令）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { probeT2Isolated } from '../src/v3/adapters/retrieval/t2-probe.mjs'
import { createFakeT2Child } from './helpers/fake-t2-child.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t2-probe-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function seedToken(root) {
  await writeFile(path.join(root, 't2-token'), 'mdcg1.recorder.abcdef.secret\n', 'utf8')
}

test('探测成功：initialize + tools/list + 写 + 读回 + 清理，交回 handle', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.10',
      spawnImpl: () => createFakeT2Child({ tools: ['cg', 'stg'] }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, true, JSON.stringify(described))
    assert.equal(described.isolated, true)
    assert.equal(described.version, '0.9.10')
    assert.deepEqual(described.tools, ['cg', 'stg'])
    assert.equal(described.smokeCleanup, 'done')
    assert.equal(typeof described.handle.callTool, 'function')
    await described.handle.close()
  })
})

test('缺 cg：smokePassed=false 且 reason 指明工具面', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.10',
      spawnImpl: () => createFakeT2Child({ tools: ['stg'] }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, false)
    assert.match(described.error, /缺 cg/)
    assert.equal(described.handle, undefined)
  })
})

test('写失败：冒烟不得判通过（isError 传回原因）', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.10',
      spawnImpl: () => createFakeT2Child({
        onTool: (args) => (args.op === 'write' ? { isError: true, body: { error: '六要素缺失' } } : undefined),
      }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, false)
    assert.match(described.error, /六要素缺失/)
  })
})

test('读回无标记：冒烟失败（写成功不等于读得回）', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.10',
      spawnImpl: () => createFakeT2Child({
        onTool: (args) => (args.op === 'read' && typeof args.node_id === 'string'
          ? { body: { id: args.node_id, content: '没有标记的正文' } }
          : undefined),
      }),
      timeoutMs: 1000,
    })
    assert.equal(described.smokePassed, false)
    assert.match(described.error, /没有看到标记/)
  })
})

test('版本取 serverInfo.version（真实运行版本优先于包版本）', async () => {
  await withRoot(async (root) => {
    await seedToken(root)
    const described = await probeT2Isolated({
      root,
      repoRoot: 'C:/tmp/dsh-memory',
      version: '0.9.10',
      spawnImpl: () => createFakeT2Child(),
      timeoutMs: 1000,
    })
    assert.equal(described.version, '0.9.10')
    await described.handle.close()
  })
})