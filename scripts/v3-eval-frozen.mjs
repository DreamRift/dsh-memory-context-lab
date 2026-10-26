#!/usr/bin/env node
/**
 * v3 冻结查询集评估（2026-10-26，方案 §5.2 前置）：
 *   build：从指定会话库分层抽样真实记录 → 冻结查询集（query 取正文片段，期望命中原 recordId）
 *   run：复跑冻结集 → rank@1/@3、MRR 汇总，输出 JSON 报告供修复前后对比。
 * 只读：打开会话库走只读检索，不写库（index 若陈化会重建——派生物，可接受）。
 * 用法：
 *   node scripts/v3-eval-frozen.mjs --build <sessionKey> [--out frozen.json] [--root <v3Root>]
 *   node scripts/v3-eval-frozen.mjs --run <frozen.json> [--out report.json] [--root <v3Root>]
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--build') a.build = argv[++i]
    else if (argv[i] === '--run') a.run = argv[++i]
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--root') a.root = argv[++i]
    else a._.push(argv[i])
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const root = args.root ?? path.join(os.homedir(), '.dsh', '.memory-context-lab', 'v3')

async function openProvider(sessionKey) {
  const { port, store } = await createSessionStorePort(root, sessionKey)
  const metrics = { counter() {}, gauge() {} }
  return { port, store, provider: createT1Provider({ port, store, metrics }) }
}

/**
 * 记录正文片段做查询：跳过 markdown 前缀噪声，取首句的连续汉字/字母段。
 * 查询须有区分度：≥6 字符；开发语料高频泛词（path/start/html…）作停用词跳过。
 */
const GENERIC_TERMS = new Set(['path', 'start', 'background', 'html', 'test', 'file', 'error', 'code', 'node', 'npm', 'data', 'value', 'true', 'false', 'undefined', 'string', 'number', 'object', 'index', 'size', 'name', 'text', 'content', 'message', 'context', 'session', 'plugin', 'config', 'query', 'result'])
function queryOf(text) {
  const clean = String(text).replace(/[#>*\-`\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = clean.match(/[\p{Script=Han}\w]{4,24}/gu) ?? []
  for (const w of words) {
    if (/[\p{Script=Han}]/u.test(w)) return w
    if (w.length >= 6 && !GENERIC_TERMS.has(w.toLowerCase())) return w
  }
  // 中文短语优先；全英文时找第一个非泛词（≥6 字符）
  const phrase = clean.match(/[\p{Script=Han}]{6,24}|[\p{Script=Han}\w]{6,24}/u)
  return phrase ? phrase[0] : ''
}

async function build(sessionKey) {
  const { store, provider } = await openProvider(sessionKey)
  const ids = (await store.listRecordIds()).filter((id) => !store.listForgotten().includes(id))
  // 分层桶：user / assistant / 其他可检索正文，按长度分短长
  const buckets = { userShort: [], userLong: [], assistantShort: [], assistantLong: [], other: [] }
  // 宿主注入的样板文本（system-reminder/runtime context/时间戳行）重复极多，作查询语料无区分度，跳过
  const boiler = /^\s*(<system-reminder>|Current runtime context|Time sampled while|以下由 untrusted-memory|【灵枢)/
  for (const id of ids) {
    const r = await store.readRecord(id)
    const p = r?.payload ?? {}
    if (!p.text || p.metaOnly) continue
    const text = String(p.text)
    if (boiler.test(text)) continue
    const kind = String(r?.kind ?? '')
    const len = text.length
    const item = { recordId: id, kind, len, textHead: text.slice(0, 24) }
    if (/user/i.test(kind)) (len < 400 ? buckets.userShort : buckets.userLong).push(item)
    else if (/assistant/i.test(kind)) (len < 800 ? buckets.assistantShort : buckets.assistantLong).push(item)
    else buckets.other.push(item)
  }
  // 每桶最多 4 条，均匀取（避免全取头部）
  const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / Math.min(n, arr.length))) === 0).slice(0, n)
  const chosen = [...pick(buckets.userShort, 3), ...pick(buckets.userLong, 3), ...pick(buckets.assistantShort, 3), ...pick(buckets.assistantLong, 3), ...pick(buckets.other, 2)]
  const cases = []
  for (const c of chosen) {
    const r = await store.readRecord(c.recordId)
    const query = queryOf(r.payload.text)
    if (!query) continue
    cases.push({ recordId: c.recordId, kind: c.kind, len: c.len, textHead: c.textHead, query })
  }
  const frozen = { builtAt: new Date().toISOString(), sessionKey, root, totalRecords: ids.length, cases }
  const out = JSON.stringify(frozen, null, 2)
  if (args.out) await writeFile(args.out, out, 'utf8')
  console.log(`冻结集：${cases.length} 条查询（库 ${ids.length} 条记录）→ ${args.out ?? 'stdout'}`)
  if (!args.out) console.log(out)
  return frozen
}

async function run(frozenPath) {
  const frozen = JSON.parse(await readFile(frozenPath, 'utf8'))
  const { provider, store } = await openProvider(frozen.sessionKey)
  const results = []
  let hit1 = 0, hit3 = 0, mrr = 0
  for (const c of frozen.cases) {
    const r = await provider.search(c.query, { limit: 10 })
    const display = r?.display ?? []
    let rank = display.findIndex((d) => d.id === c.recordId) + 1
    // 同文重复记录（多拷贝）按文本锚兜底：top3 中首条文本锚相同的视为命中
    if (rank === 0 && c.textHead) {
      for (let i = 0; i < Math.min(3, display.length); i++) {
        const rec = await store.readRecord(display[i].id)
        if (String(rec?.payload?.text ?? '').startsWith(c.textHead.slice(0, 12))) { rank = i + 1; break }
      }
    }
    if (rank === 1) hit1 += 1
    if (rank >= 1 && rank <= 3) hit3 += 1
    if (rank >= 1) mrr += 1 / rank
    results.push({ query: c.query, kind: c.kind, len: c.len, rank: rank || null, top: display[0]?.id ?? null, topScore: display[0]?.score ?? null })
  }
  const n = frozen.cases.length || 1
  const report = { runAt: new Date().toISOString(), frozen: frozenPath, sessionKey: frozen.sessionKey, cases: n, hit1, hit3, mrr: Number((mrr / n).toFixed(3)), results }
  const out = JSON.stringify(report, null, 2)
  if (args.out) await writeFile(args.out, out, 'utf8')
  console.log(`命中@1 ${hit1}/${n}（${(hit1 / n * 100).toFixed(0)}%）  命中@3 ${hit3}/${n}（${(hit3 / n * 100).toFixed(0)}%）  MRR ${(mrr / n).toFixed(3)}`)
  const misses = results.filter((r) => !r.rank)
  if (misses.length) console.log(`未命中 ${misses.length} 条：` + misses.map((m) => JSON.stringify(m.query)).join(' '))
  if (!args.out) console.log(out)
  return report
}

if (args.build) await build(args.build)
else if (args.run) await run(args.run)
else {
  console.error('用法：--build <sessionKey> | --run <frozen.json>（可选 --out/--root）')
  process.exitCode = 2
}
