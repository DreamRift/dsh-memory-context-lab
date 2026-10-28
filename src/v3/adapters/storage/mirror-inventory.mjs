/**
 * T2 隔离根镜像清单（adapters/storage，0.14.0-beta.38）。
 *
 * 只做两件只读事实采集，供覆盖率诊断与显式回填计划使用：
 * - scanMirroredNodes(root)：隔离根里真实写成的节点（按 v3r-* 文件计数），
 *   冒烟节点与写入闸拒绝节点单独计数、**不计入覆盖率**；
 * - scanMirrorableRecords(store)：本地已提交记录里 payload.text 非空、未遗忘的那部分，
 *   即「可镜像」的真实分母（metadata-only 与空正文不进分母）。
 *
 * 为什么直接读 records/ 而不是逐条走 store.readRecord：readRecord 每条都要刷新遗忘
 * 文件戳（一次 stat）并做全量结构校验，5431 条实测 1053ms；本模块一次 listForgotten +
 * 一次 readdir + 并发读文件，同规模 120ms。它是命令/诊断路径，不在 pre-step 热路径上。
 *
 * 失败模式：清单与磁盘不一致（记录文件缺失/JSON 损坏）一律抛出，由调用方显示「未知」，
 * 绝不用 0 冒充「没有可镜像记录」。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { v3Error } from '../../contracts/errors.mjs'
import { T2_MIRROR_NODE_RE, T2_REJECTED_NODE_RE, T2_SMOKE_NODE_ID } from '../../contracts/t2.mjs'

export const MIRROR_RECORDS_DIR = 'records'

/** 会话隔离根下的 T2 目录（entry 层不得 import node:path，root 解析收在适配器里）。 */
export function mirrorRootOf(directory) {
  return path.join(String(directory ?? ''), 't2-mdcg')
}

/**
 * 扫描隔离根里的节点文件。
 *
 * @param {string} root 会话隔离根下的 t2-mdcg
 * @returns {Promise<{state:'ok'|'absent', files:number, mirrored:number, smoke:number, rejected:number, other:number, nodes:Set<string>}>}
 *   state=absent 表示隔离根尚不存在（不是错误，也不是「0 条真实覆盖」的另一种说法——
 *   调用方必须把 absent 与 ok+0 分开显示）
 */
export async function scanMirroredNodes(root) {
  const out = {
    state: 'ok',
    files: 0,
    mirrored: 0,
    smoke: 0,
    rejected: 0,
    other: 0,
    nodes: new Set(),
  }
  if (typeof root !== 'string' || root.length === 0) {
    out.state = 'absent'
    return out
  }
  try {
    await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      out.state = 'absent'
      return out
    }
    throw error
  }
  const ids = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      ids.push(entry.name.slice(0, -3))
    }
  }
  await walk(root)
  out.files = ids.length
  for (const id of ids) {
    if (id === T2_SMOKE_NODE_ID) {
      out.smoke += 1
      continue
    }
    if (T2_MIRROR_NODE_RE.test(id)) {
      out.nodes.add(id)
      continue
    }
    if (T2_REJECTED_NODE_RE.test(id)) {
      out.rejected += 1
      continue
    }
    out.other += 1
  }
  out.mirrored = out.nodes.size
  return out
}

/**
 * 扫描本地已提交记录，分出「可镜像 / metadata-only / 空正文 / 已遗忘」。
 *
 * @param {object} store session-store 端口（需要 directory / listRecordIds / listForgotten）
 * @param {object} [options]
 * @param {boolean} [options.collectRecords=true] 是否保留记录对象（回填要；覆盖率只要计数）
 * @param {number} [options.concurrency=32] 并发读文件数
 * @returns {Promise<{total:number, forgotten:number, mirrorable:number, metaOnly:number, emptyText:number, records:object[]}>}
 */
export async function scanMirrorableRecords(store, { collectRecords = true, concurrency = 32 } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.directory !== 'string') {
    throw v3Error('EINTERNAL', 'v3 mirror-inventory: 需要 session-store 端口（含 directory）')
  }
  const ids = typeof store.listRecordIds === 'function' ? await store.listRecordIds() : []
  const forgotten = new Set(typeof store.listForgotten === 'function' ? store.listForgotten() : [])
  const counts = { total: ids.length, forgotten: 0, mirrorable: 0, metaOnly: 0, emptyText: 0 }
  const records = []
  let cursor = 0
  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= ids.length) return
      const id = ids[index]
      if (forgotten.has(id)) {
        counts.forgotten += 1
        continue
      }
      let text
      try {
        text = await readFile(path.join(store.directory, MIRROR_RECORDS_DIR, id + '.json'), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw v3Error('ESTORE_CORRUPT', '记录文件缺失：' + id + '（提交清单与磁盘不一致，覆盖率未知）')
        }
        throw error
      }
      let record
      try {
        record = JSON.parse(text)
      } catch {
        throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' JSON 不可解析（覆盖率未知）')
      }
      const body = record?.payload?.text
      if (typeof body === 'string' && body.length > 0 && record?.id === id) {
        counts.mirrorable += 1
        if (collectRecords) records.push(record)
        continue
      }
      if (record?.payload?.metaOnly === true) {
        counts.metaOnly += 1
        continue
      }
      counts.emptyText += 1
    }
  }
  const width = Math.max(1, Math.min(concurrency, ids.length === 0 ? 1 : ids.length))
  await Promise.all(Array.from({ length: width }, () => worker()))
  // 稳定次序：回填计划与测试断言不依赖文件系统遍历顺序。
  if (collectRecords) records.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { ...counts, records }
}
