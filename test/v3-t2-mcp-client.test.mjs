/**
 * T2 隔离 MCP 客户端测试（beta.35）。
 *
 * 判据（T2 隔离设计 §3.1）：
 * - initialize + notifications/initialized 握手成功，tools/list 可读；
 * - tools/call 解析 content[0].text 的 JSON；isError / JSON-RPC error 都失败关闭；
 * - 超时、进程退出必须 reject，且不得遗留 pending；
 * - close 幂等、尽力发 shutdown；诊断只暴露 stderr 尾部。
 *
 * 使用假子进程（PassThrough）验证，不启动 Python；真实进程由 scripts/t2-smoke.mjs 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { contentOfNodeView, createT2McpClient } from '../src/v3/adapters/retrieval/t2-mcp-client.mjs'
import { createFakeT2Child } from './helpers/fake-t2-child.mjs'

const OPTIONS = {
  root: 'C:/tmp/t2-root',
  repoRoot: 'C:/tmp/dsh-memory',
  python: 'python',
  tokenStoreFile: 'C:/tmp/t2-root/tokens.json',
  token: 'mdcg1.recorder.abcdef.secret',
}

function clientWith(child, overrides = {}) {
  return createT2McpClient({
    ...OPTIONS,
    spawnImpl: () => child,
    ...overrides,
  })
}

test('start：握手成功，返回 serverInfo 与工具名', async () => {
  const client = clientWith(createFakeT2Child({ tools: ['cg', 'stg'] }))
  const started = await client.start()
  assert.equal(started.protocolVersion, '2024-11-05')
  assert.equal(started.serverInfo.name, 'mdcg-mcp')
  assert.deepEqual(started.tools, ['cg', 'stg'])
  await client.close()
})

test('callTool：解析 text 里的 JSON 结果', async () => {
  const client = clientWith(createFakeT2Child({ onTool: () => ({ body: { ok: true, node_id: 'v3r-0123456789abcdef' } }) }))
  await client.start()
  const result = await client.callTool('cg', { op: 'write' })
  assert.equal(result.ok, true)
  assert.equal(result.node_id, 'v3r-0123456789abcdef')
  await client.close()
})

test('callTool：isError=true 必须拒绝（不把工具错误当结果）', async () => {
  const client = clientWith(createFakeT2Child({ onTool: () => ({ isError: true, body: { error: '六要素缺失' } }) }))
  await client.start()
  await assert.rejects(() => client.callTool('cg', { op: 'write' }), /六要素缺失/)
  await client.close()
})

test('callTool：JSON-RPC error 必须拒绝并带 code', async () => {
  const client = clientWith(createFakeT2Child({ onTool: () => ({ error: { code: -32602, message: 'arguments 非法' } }) }))
  await client.start()
  await assert.rejects(() => client.callTool('cg', { op: 'read' }), /-32602/)
  await client.close()
})

test('超时：挂起的请求 reject，不把超时当成功', async () => {
  const client = clientWith(createFakeT2Child({ hangOn: (message) => message.method === 'tools/call' }), {
    requestTimeoutMs: 120,
  })
  await client.start()
  await assert.rejects(() => client.callTool('cg', { op: 'read' }), /超时/)
  await client.close()
})

test('进程退出：在飞请求 reject，reason 带退出码', async () => {
  const client = clientWith(createFakeT2Child({
    exitOn: (message) => message.method === 'tools/call',
  }))
  await client.start()
  await assert.rejects(() => client.callTool('cg', { op: 'read' }), /子进程退出/)
  await client.close()
})

test('start：initialize 无响应时超时并关闭子进程', async () => {
  const failing = clientWith(createFakeT2Child({
    hangOn: (message) => message.method === 'initialize',
  }), { startupTimeoutMs: 30 })
  await assert.rejects(() => failing.start(), /超时|启动失败/)
})

test('close：幂等；关闭后 callTool 拒绝', async () => {
  const client = clientWith(createFakeT2Child())
  await client.start()
  await client.close()
  await client.close()
  await assert.rejects(() => client.callTool('cg', { op: 'read' }), /已关闭|已退出|未 start/)
})

test('contentOfNodeView：单节点视图与 node 包装两种形态', () => {
  assert.equal(contentOfNodeView({ content: 'abc' }), 'abc')
  assert.equal(contentOfNodeView({ node: { content: 'def' } }), 'def')
  assert.equal(contentOfNodeView({ results: [] }), null)
  assert.equal(contentOfNodeView(null), null)
})