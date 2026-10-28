/**
 * T2 MCP 假子进程（测试夹具）：用 PassThrough 模拟 `python -m md_cg.mcp_server`。
 *
 * 只实现客户端真正用到的协议面：initialize / notifications/initialized /
 * tools/list / tools/call / shutdown。可按需制造超时、协议错误、进程退出。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export function createFakeT2Child({
  tools = ['cg', 'stg'],
  onTool = null,
  hangOn = null,
  exitOn = null,
  exitCode = 1,
} = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0, null)
  }
  child.stdin.end = function end(...args) {
    PassThrough.prototype.end.apply(this, args)
    queueMicrotask(() => child.emit('exit', exitCode, null))
  }

  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      const message = JSON.parse(line)
      dispatch(message)
    }
  })

  function reply(id, result) {
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }
  function replyError(id, code, message) {
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
  }

  function dispatch(message) {
    if (hangOn !== null && hangOn(message)) return
    if (exitOn !== null && exitOn(message)) {
      child.emit('exit', exitCode, null)
      return
    }
    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mdcg-mcp', version: '0.9.10' },
      })
      return
    }
    if (message.method === 'notifications/initialized' || message.method === 'initialized') return
    if (message.method === 'tools/list') {
      reply(message.id, { tools: tools.map((name) => ({ name })) })
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      if (name !== 'cg') {
        replyError(message.id, -32602, 'unknown tool: ' + name)
        return
      }
      if (typeof onTool === 'function') {
        const custom = onTool(args)
        if (custom !== undefined) {
          if (custom.error !== undefined) {
            replyError(message.id, custom.error.code ?? -32603, custom.error.message ?? 'tool error')
            return
          }
          if (custom.isError === true) {
            child.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: JSON.stringify(custom.body ?? { error: 'tool error' }) }], isError: true },
            }) + '\n')
            return
          }
          reply(message.id, {
            content: [{ type: 'text', text: JSON.stringify(custom.body ?? custom) }],
            isError: false,
          })
          return
        }
      }
      if (args.op === 'write') {
        reply(message.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, node_id: args.node_id, committed: true }) }],
          isError: false,
        })
        return
      }
      if (args.op === 'read') {
        if (typeof args.node_id === 'string') {
          reply(message.id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: args.node_id,
                frontmatter: { created: '2026-10-28T00:00:00Z' },
                content: '# 功能名：镜像\n# 生效条件：测试\n# 子功能：读回\n# 执行：mcl-t2-smoke\n# 验证方式：读回\n# 不适用条件：测试',
              }),
            }],
            isError: false,
          })
          return
        }
        reply(message.id, {
          content: [{
            type: 'text',
            text: JSON.stringify({
              meta: {},
              results: [{ node: { id: 'v3r-0123456789abcdef' }, score: 0.4 }],
            }),
          }],
          isError: false,
        })
        return
      }
      if (args.op === 'forget') {
        reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false })
        return
      }
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ ok: true, op: args.op }) }], isError: false })
      return
    }
    if (message.method === 'shutdown') {
      reply(message.id, {})
      return
    }
    if (message.id !== undefined) replyError(message.id, -32601, 'method not found: ' + message.method)
  }

  return child
}