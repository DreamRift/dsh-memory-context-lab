#!/usr/bin/env node
/**
 * 宿主契约探针（0.14.0-beta.44，源码级）。
 *
 * 为什么替换旧版：0.14.0-beta.43 的 host-schema-probe 还在 import `src/v2/tool.mjs`
 * （v2 已删除），`npm run probe:host` 直接 ERR_MODULE_NOT_FOUND。v3 没有工具面
 * （memory_lab_recall 已不存在），继续校验旧工具 schema 是自欺欺人。
 *
 * 这个探针只读本机 app.asar 里的**真实宿主源码**，检查插件实际依赖的契约是否还在：
 * - CommandResult / normalizeResult（命令 handler 必须返回 {kind,text}）；
 * - agent/pre-step 的 decision.messages 与 surfaceOp append；
 * - dsh-session 的 toolCallId 与 sourceEventSeqs 密集覆盖判据。
 * 它不能替代运行时测试，但能在宿主升级后第一时间指出契约漂移。
 *
 * B3-28（AUD50-10-06）：检查清单必须覆盖插件实际消费的宿主字段（payload.turn /
 * data.turn / session.log / surface.nodes / payload.messages）；数量由
 * test/v3-host-probe.test.mjs 钉死。**升级 DSH 的人工核对项**：升级后先跑本探针，
 * 再对照「插件 src 对宿主对象的字段读取」grep 一遍，未覆盖字段在此补检查。
 *
 * 用法：
 *   node test/helpers/host-contract-probe.mjs --asar "<DSH>/resources/app.asar"
 *   DSH_ASAR=<...> npm run probe:host
 * 没有 --asar / DSH_ASAR 时打印 SKIP 并退 0（与旧探针口径一致，不假装验过）。
 */
import fs from 'node:fs'
import path from 'node:path'

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const asar = argOf('--asar') ?? process.env.DSH_ASAR
if (typeof asar !== 'string' || asar.trim().length === 0) {
  console.log('[probe:host] SKIP：未提供 --asar / DSH_ASAR。示例：npm run probe:host -- --asar "C:\\yinyong\\DeepSeek Harness\\resources\\app.asar"')
  process.exit(0)
}
if (!fs.existsSync(asar)) {
  console.error('[probe:host] 找不到 app.asar：' + asar)
  process.exit(1)
}

function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const dataStart = 8 + head.readUInt32LE(4)
  const jsonLength = head.readUInt32LE(12)
  const header = Buffer.alloc(jsonLength)
  fs.readSync(fd, header, 0, jsonLength, 16)
  const tree = JSON.parse(header.toString('utf8'))
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = prefix ? prefix + '/' + name : name
      if (value.files) walk(value, full)
      else entries.set(full, { offset: Number(value.offset), size: Number(value.size) })
    }
  }
  walk(tree, '')
  return {
    read(entry) {
      const found = entries.get(entry)
      if (found === undefined) throw new Error('asar 内没有 ' + entry)
      const buffer = Buffer.alloc(found.size)
      if (found.size > 0) fs.readSync(fd, buffer, 0, found.size, dataStart + found.offset)
      return buffer.toString('utf8')
    },
    close() { fs.closeSync(fd) },
  }
}

const archive = openAsar(asar)
try {
  const files = {
    manifest: 'dsh/package.json',
    commands: 'dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js',
    loop: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    session: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  }
  const source = Object.fromEntries(Object.entries(files).map(([key, entry]) => [key, archive.read(entry)]))
  let version = 'unknown'
  try { version = JSON.parse(source.manifest).version ?? 'unknown' } catch {}
  const checks = [
    ['dsh-commands: normalizeResult', () => /function normalizeResult/.test(source.commands)],
    ['dsh-commands: CommandResult 形状', () => /handler must return a CommandResult/.test(source.commands)],
    ['dsh-agent-loop: decision.messages', () => /decision\.messages/.test(source.loop)],
    ['dsh-agent-loop: surfaceOp append', () => /surfaceOp:\s*["']append["']/.test(source.loop)],
    ['dsh-session: toolCallId（真实 tool/result 配对键）', () => /toolCallId/.test(source.session)],
    ['dsh-session: sourceEventSeqs 密集覆盖', () => /assertSourceEventReferences|sourceEventSeqs/.test(source.session)],
    // B3-28（AUD50-10-06）：插件消费的其余宿主契约字段（旧探针 6/6 假绿，这些字段改名发现不了）。
    // 增删检查时同步 test/v3-host-probe.test.mjs 的 EXPECTED_CHECKS。以下正则已对 0.14.0-beta.50
    // 宿主源码逐条核验命中。
    ['dsh-agent-loop: pre-step payload.turn（position 展开进 waterfall）', () => /waterfall\(\s*["']agent\/pre-step["'][\s\S]{0,120}\.\.\.position/.test(source.loop)],
    ['dsh-agent-loop: pre-step payload.messages', () => /waterfall\(\s*["']agent\/pre-step["'][\s\S]{0,80}messages:\s*claimed/.test(source.loop)],
    ['dsh-agent-loop: turn/start data.turn', () => /lastTurn:\s*event\.data\.turn/.test(source.loop)],
    ['dsh-session: session.log（事件日志数组）', () => /this\.log\s*=/.test(source.session)],
    ['dsh-session: session.surface.nodes', () => /get surface\(\)\s*\{\s*return this\.surfaceManager/.test(source.session) && /get nodes\(\)/.test(source.session)],
  ]
  const failed = []
  for (const [label, check] of checks) {
    let ok = false
    try { ok = check() } catch { ok = false }
    console.log((ok ? 'PASS ' : 'FAIL ') + label)
    if (!ok) failed.push(label)
  }
  console.log('[probe:host] dsh=' + version + ' checks=' + checks.length + ' failed=' + failed.length)
  if (failed.length > 0) {
    console.error('[probe:host] 宿主契约漂移：' + failed.join('；'))
    process.exit(1)
  }
  console.log('[probe:host] PASS：宿主契约字段仍在（注意：这是源码级探针，不替代运行时测试）')
} finally {
  archive.close()
}
