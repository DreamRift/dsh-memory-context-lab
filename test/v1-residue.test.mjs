/**
 * 0.13.1 守卫：v1 引擎残留扫描（基线式审计器）。
 *
 * ## 缺陷
 * 0.13.0 声称「重新设计了架构」，但 v1 引擎、双引擎互斥台账、v1 命令面、
 * v1 账本全部还在。README 把 v1 命令面指向「旧版说明」，让人以为已下线。
 * 结果是 v1 归档借道 v2 存储时写入 engine.json，把从未启用过 v2 的会话判成
 * 「v2 持有」，重启后 /memory-lab on 被 EV2ACTIVE 拒绝（会话 c1787f24）。
 *
 * ## 判据来源
 * 本文件同时是**基线文件与守卫**：`RESIDUE` 里每条都是 0.13.1 清理后仍
 * **允许存在**的引用及其理由。新增引用即失败（只准减不准增）。
 *
 * ## 断言组
 * 1. 每条允许项必须仍有引用（否则是死条目，应删除而不是留着）；
 * 2. 不允许出现任何未登记的命中；
 * 3. 关键对象（v1 命令面、v1 账本函数、engines.json 台账）必须为 0。
 *
 * ## 不适用条件与已知边界
 * 本守卫是**文本扫描**，判不出「语义上仍是 v1 行为」的代码。它绿不等于
 * 单引擎改造完成，只等于「已知的 v1 符号没有回流」。注释里的历史说明会被
 * 计入，因此白名单按「文件 + 符号 + 理由」逐条登记。
 *
 * ## 运行
 * `node --test-force-exit test/v1-residue.test.mjs`；失败退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/**
 * 允许保留的引用。每条必须写明**为什么留**，且必须真的还能扫到。
 * 新增 v1 符号时**不要往这里加**——要么改代码，要么在评审里论证。
 */
const RESIDUE = [
  {
    symbol: 'memory-lab2-surface',
    reason: '日志里的历史来源形态值。改名会让 0.13.0 及更早写下的表面节点重新被当成人类输入。',
    files: ['core.mjs', 'v2/agg-voucher.mjs', 'v2/card-fold.mjs', 'v2/runtime.mjs', 'v2/runtime-card.mjs', 'v2/runtime-compress.mjs', 'v2/runtime-forget.mjs'],
  },
  {
    symbol: '/memory-lab2',
    reason: '投影必须继续折叠 0.13.0 的旧命令记录，否则历史设置会从面板消失。',
    files: ['projection.mjs'],
  },
]

/** 必须完全消失的对象。命中任何一条即失败。 */
const MUST_BE_GONE = [
  'assertV2AllowsV1',
  'assertV1AvailableForV2',
  'v1CommandHandler',
  'enableV1',
  'createSessionState',
  'readSessionState',
  'writeSessionState',
  'listSessionStates',
  'SessionStateDamagedError',
  'importV1ArchiveEntries',
]

async function listSourceFiles(dir = SRC, base = SRC, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listSourceFiles(full, base, acc)
    else if (full.endsWith('.mjs') || full.endsWith('.js')) acc.push(path.relative(base, full).replaceAll('\\', '/'))
  }
  return acc
}

async function readAll() {
  const files = await listSourceFiles()
  const map = new Map()
  for (const rel of files) map.set(rel, await readFile(path.join(SRC, rel), 'utf8'))
  return map
}

test('量具自检：扫描器真的读到了源码', async () => {
  const files = await listSourceFiles()
  assert.ok(files.length > 30, `扫描面过小（${files.length} 个文件），扫描器可能失效`)
  assert.ok(files.includes('index.mjs'))
  assert.ok(files.includes('v2/runtime.mjs'))
})

test('MUST_BE_GONE：v1 引擎对象必须完全消失', async () => {
  const sources = await readAll()
  const hits = []
  for (const [rel, text] of sources) {
    for (const symbol of MUST_BE_GONE) {
      // 整词匹配：`V2SessionStateDamagedError` 含 `SessionStateDamagedError` 子串，
      // 用 includes 会把 v2 自己的类误判成 v1 残留。
      const re = new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
      if (re.test(text)) hits.push(`${rel}: ${symbol}`)
    }
  }
  assert.deepEqual(hits, [], `v1 引擎对象仍在：\n${hits.join('\n')}`)
})

test('白名单条目必须仍然存在（死条目应删除而不是留着）', async () => {
  const sources = await readAll()
  for (const entry of RESIDUE) {
    let found = false
    for (const rel of entry.files) {
      const text = sources.get(rel)
      if (text && text.includes(entry.symbol)) { found = true; break }
    }
    assert.equal(found, true, `白名单条目已无引用，应删除：${entry.symbol}`)
  }
})

test('白名单之外不得出现 v1 残留符号', async () => {
  const sources = await readAll()
  const allowed = new Set()
  for (const entry of RESIDUE) {
    for (const rel of entry.files) allowed.add(rel + '::' + entry.symbol)
  }
  const violations = []
  for (const [rel, text] of sources) {
    for (const entry of RESIDUE) {
      if (!text.includes(entry.symbol)) continue
      if (!allowed.has(rel + '::' + entry.symbol)) violations.push(`${rel}: ${entry.symbol}`)
    }
  }
  assert.deepEqual(violations, [], `未登记的 v1 残留：\n${violations.join('\n')}`)
})

test('只注册一条命令', async () => {
  const text = await readFile(path.join(SRC, 'index.mjs'), 'utf8')
  const registrations = (text.match(/ctx\.commands\.register\(/g) || []).length
  assert.equal(registrations, 1, `index.mjs 应只注册一条命令，实际 ${registrations} 处`)
})
