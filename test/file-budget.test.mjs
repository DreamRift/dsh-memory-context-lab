/**
 * P1-4（beta.9）：拆分粒度守卫——防大文件回涨。
 *
 * 判据：src 递归下每个 .mjs（含 client.js）每文件 ≤40KB，白名单除外。白名单**只缩不涨**：
 * 每项附一行理由；拆分或缩身后请把条目摘掉。
 *
 * ## 运行
 * node --test-force-exit test/file-budget.test.mjs；超限退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BUDGET = 40 * 1024

/**
 * 白名单：键 = 相对 src 路径（正斜杠），值 = 一行理由。
 * beta.9 P1-1：core/apply 已达标摘条。apply-engine 保留条目：顶层可搬工具族仅
 * 9.5K，主体 createEngine 是闭包工厂（1386 行共享 registries 等闭包状态），
 * 纯搬移纪律下拆至 62.8K 即到边界；继续拆需参数化注入（签名变化=逻辑改动），
 * 留给后续版本专门重构。
 */
const WHITELIST = new Map(Object.entries({
  'apply-engine.mjs': 'createEngine 为闭包工厂，纯搬移拆分边界 62.8K；参数化重构留后续版本（beta.9 P1-1）',
  'client.js': '面板单文件 IIFE（浏览器直载，无构建步骤）；按渲染域拆分属面板重构另行任务',
  'v2/working-state.mjs': 'v2 工作状态单域（投影/保护/最小依赖集同域强耦合）；拆分另行任务',
  'v2/store.mjs': '隔离冷库事务存储单域（事务/清单/隔离区同域）；拆分另行任务',
}))

async function listAll(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listAll(full)))
    else if (entry.name.endsWith('.mjs') || entry.name === 'client.js') out.push(full)
  }
  return out
}

test('P1-4：每文件 ≤40KB（白名单外），白名单只缩不涨', async () => {
  const files = await listAll(SRC)
  const offenders = []
  for (const file of files) {
    const rel = path.relative(SRC, file).replaceAll('\\', '/')
    const size = (await readFile(file, 'utf8')).length
    if (size <= BUDGET) continue
    if (WHITELIST.has(rel)) continue
    offenders.push(rel + ' = ' + (size / 1024).toFixed(1) + 'KB')
  }
  assert.deepEqual(offenders, [], '这些文件超过 40KB 且不在白名单（拆分或写明白名单）：\n' + offenders.join('\n'))
  const unknown = [...WHITELIST.keys()].filter((rel) => {
    const full = path.join(SRC, ...rel.split('/'))
    return !files.includes(full)
  })
  assert.deepEqual(unknown, [], '白名单里有 src 已不存在的文件（请清理）：' + unknown.join('、'))
})
