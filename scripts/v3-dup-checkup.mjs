#!/usr/bin/env node
/**
 * H-01 存量重复体检（只读，不改任何字节）：按 provenance.sourceEventId 分组统计重复。
 * 用法：node scripts/v3-dup-checkup.mjs [--root <v3Root>] [--fix-dry-run]
 *   --fix-dry-run 额外打印若执行合并（superseded 标记）会影响哪些记录（仍不写）。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

const root = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.join(os.homedir(), '.dsh', '.memory-context-lab', 'v3')
const dryRun = process.argv.includes('--fix-dry-run')

const sessionsDir = path.join(root, 'sessions')
let sessions
try { sessions = (await readdir(sessionsDir)).filter((d) => d.startsWith('session-') && !d.includes('-old-')) } catch { console.log('无 sessions 目录'); process.exit(0) }

let grand = { sessions: 0, records: 0, distinctEvents: 0, dupRecords: 0, dupBytes: 0 }
for (const s of sessions) {
  const dir = path.join(sessionsDir, s)
  let lines
  try { lines = (await readFile(path.join(dir, 'transactions.jsonl'), 'utf8')).split('\n').filter(Boolean) } catch { continue }
  const byEvent = new Map()
  let recs = 0
  for (const line of lines) {
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.action !== 'commit' || !Array.isArray(obj.recordIds)) continue
    for (const id of obj.recordIds) { recs += 1 }
  }
  // 记录级分组（读 records 目录的 provenance 太贵——用提交行先数总量，抽样读记录核对）
  // 改为直接扫 records 目录文件
  const recDir = path.join(dir, 'records')
  let files = []
  try { files = (await readdir(recDir)).filter((f) => f.endsWith('.json')) } catch { continue }
  const ev = new Map()
  let dup = 0, dupBytes = 0
  for (const f of files) {
    let r
    try { r = JSON.parse(await readFile(path.join(recDir, f), 'utf8')) } catch { continue }
    const key = r?.provenance?.sourceEventId
    if (!key) { continue }
    if (ev.has(key)) {
      dup += 1
      dupBytes += r?.payload?.bytes ?? 0
      if (dryRun) ev.get(key).push(r.id)
    } else ev.set(key, [r.id])
  }
  if (files.length === 0) continue
  grand.sessions += 1; grand.records += files.length; grand.distinctEvents += ev.size; grand.dupRecords += dup; grand.dupBytes += dupBytes
  console.log(`${s.slice(8, 24)}  记录 ${files.length}  不同事件 ${ev.size}  重复 ${dup}（${(dup / files.length * 100).toFixed(1)}%）  重复字节 ${(dupBytes / 1024).toFixed(0)}KB`)
}
console.log('---')
console.log(`合计：${grand.sessions} 会话  ${grand.records} 记录  ${grand.distinctEvents} 不同事件  重复 ${grand.dupRecords} 条（${(grand.dupRecords / Math.max(1, grand.records) * 100).toFixed(1)}%）  ${(grand.dupBytes / 1024 / 1024).toFixed(1)}MB`)
