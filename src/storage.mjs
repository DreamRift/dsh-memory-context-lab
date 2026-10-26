import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
// 0.14.0-beta.10：v2 退场后这些常量由本模块持有（值与 v2 时期完全一致）。
export const LAB_ROOT_NAME = '.memory-context-lab'
export const SCHEMA_VERSION = 1

export function defaultDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured ? path.resolve(configured) : path.join(homedir(), '.dsh')
}

export function labRootFor(env = process.env) {
  return path.join(defaultDshHome(env), LAB_ROOT_NAME)
}

