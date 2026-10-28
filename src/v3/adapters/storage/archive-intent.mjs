/**
 * 归档意图（crash journal）：surface replace 前落盘，成功后清。
 *
 * 为什么需要：surface 与 store 不是一个事务。若 replace 已生效、voucher 还没写，
 * 原文仍在日志但活动面只剩回执，恢复凭证缺失。下个 pre-step 按 intent 找“正文等于
 * receiptText 的 surface 节点”，补 voucher；找不到就清掉（不推进 state）。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sessionStatePath } from './session-state.mjs'
import { writeFileAtomic } from './session-store.mjs'

const FILE = 'archive-intent.json'

export function archiveIntentPath(v3Root, sessionId) {
  return join(dirname(sessionStatePath(v3Root, sessionId)), FILE)
}

export async function writeArchiveIntent(v3Root, sessionId, intent) {
  await writeFileAtomic(archiveIntentPath(v3Root, sessionId), JSON.stringify(intent) + '\n')
}

export async function readArchiveIntent(v3Root, sessionId) {
  try {
    return JSON.parse(await readFile(archiveIntentPath(v3Root, sessionId), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function clearArchiveIntent(v3Root, sessionId) {
  const { rm } = await import('node:fs/promises')
  await rm(archiveIntentPath(v3Root, sessionId), { force: true })
}