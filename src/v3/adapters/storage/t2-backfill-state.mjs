/**
 * 回填状态文件（adapters/storage，0.14.0-beta.38）。
 *
 * 每会话一个 t2-backfill.json：记录**最近一次**显式回填的计划量、进度与结局。
 * 它不是幂等判据（幂等靠隔离根里真实存在的 v3r-* 节点），只是可读的进度面：
 * 进程重启后，已镜像的节点仍在磁盘上，下一次回填自然跳过。
 *
 * 写入走 writeFileAtomic（randomUUID 临时名 + rename）；读取遇到坏 JSON 抛
 * ESTORE_CORRUPT，由调用方显示「未知」，不拿 0 冒充「没回填过」。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { v3Error } from '../../contracts/errors.mjs'
import { writeFileAtomic } from './session-store.mjs'

export const T2_BACKFILL_FILE = 't2-backfill.json'

function statePath(directory) {
  return path.join(directory, T2_BACKFILL_FILE)
}

/** @returns {Promise<object|null>} 文件不存在返回 null（从未回填过）。 */
export async function readBackfillState(directory) {
  let text
  try {
    text = await readFile(statePath(directory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw v3Error('ESTORE_CORRUPT', T2_BACKFILL_FILE + ' 损坏（回填进度未知，不拿 0 冒充）')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw v3Error('ESTORE_CORRUPT', T2_BACKFILL_FILE + ' 形状非法（回填进度未知）')
  }
  return parsed
}

/** 原子写回填状态；返回写入后的对象（含 updatedAt）。 */
export async function writeBackfillState(directory, state) {
  const payload = { schemaVersion: 1, ...state, updatedAt: Date.now() }
  await writeFileAtomic(statePath(directory), JSON.stringify(payload) + '\n')
  return payload
}
