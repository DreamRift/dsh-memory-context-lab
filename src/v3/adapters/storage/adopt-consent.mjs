/**
 * `adopt-from` 的父会话同意门（H5，2026-11-04 独立审计）。
 *
 * 事故面：`adopt-from <会话ID>` 只要目标为空、父会话在本进程打开，就把父会话**全部正文**
 * 复制进子会话——没有任何归属校验。会话 ID 可从 status/导出文件名拿到，等于「知道 ID
 * 就能取走另一个会话的记忆」，直接突破计划 §10「每会话冷库隔离」。
 *
 * 现在：默认**拒绝**，父会话必须由用户显式执行 `/memory-lab adopt-allow on`
 * （写 `<会话目录>/adopt-consent.json`）。这是有状态、可审计、可撤销的授权，
 * 不是「再问一次」；命令面在父会话里能看到当前是否允许被复制。
 *
 * 文件形状故意极小：`{ schemaVersion, allow, sessionKey, updatedAt }`。损坏 → 失败关闭
 * （读不到就当不允许），不把「读不了」解释成「允许」。
 */
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from './session-store.mjs'

export const ADOPT_CONSENT_SCHEMA_VERSION = 1
const FILE = 'adopt-consent.json'

export function adoptConsentPath(directory) {
  return path.join(directory, FILE)
}

/** @returns {Promise<{allow:boolean, exists:boolean, error?:string, updatedAt?:number|null}>} */
export async function readAdoptConsent(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return { allow: false, exists: false, error: 'no-directory' }
  let text
  try {
    text = await readFile(adoptConsentPath(directory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { allow: false, exists: false, updatedAt: null }
    return { allow: false, exists: false, error: error?.code ?? String(error) }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { allow: false, exists: true, error: 'consent-corrupt', updatedAt: null } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { allow: false, exists: true, error: 'consent-shape', updatedAt: null }
  if (parsed.schemaVersion !== ADOPT_CONSENT_SCHEMA_VERSION) return { allow: false, exists: true, error: 'consent-version', updatedAt: null }
  return {
    allow: parsed.allow === true,
    exists: true,
    updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null,
  }
}

/** 写入/撤销同意。`allow:false` 保留文件（可审计「何时关掉的」），不删除。 */
export async function writeAdoptConsent(directory, { allow, sessionKey = null, now = Date.now() } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('v3 adopt-consent: directory 必填')
  await mkdir(directory, { recursive: true })
  const body = JSON.stringify({
    schemaVersion: ADOPT_CONSENT_SCHEMA_VERSION,
    allow: allow === true,
    sessionKey: typeof sessionKey === 'string' ? sessionKey : null,
    updatedAt: now,
  }, null, 2) + '\n'
  await writeFileAtomic(adoptConsentPath(directory), body)
  return { allow: allow === true }
}
