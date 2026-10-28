/**
 * dsh-memory 能力探测（adapters/host，M6 T2 门）。
 *
 * 只读：读工具表 + 包版本；不写配置、不上报凭据。
 * 当前 dsh-memory 0.9.10 的 core 工具面是 cg/stg，不是 T2 合同要求的
 * memory_store/memory_search/memory_read；negotiate 会按缺工具如实回落 T1。
 * smoke 目前不执行（false）——缺工具已经先回 T1，不把“没跑冒烟”伪装成通过。
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = '@furongjun1999/dsh-memory'

async function installedVersion() {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve(PACKAGE_NAME)
    const pkg = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * @param {object} deps
 * @param {object} deps.tools Host tools 服务（需 schemas()）
 * @returns {Promise<null | {name:string,version:string,tools:string[],smokePassed:boolean}>}
 */
export async function probeDshMemory({ tools } = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.schemas !== 'function') return null
  let names = []
  try {
    names = tools.schemas().map((schema) => schema?.name).filter((name) => typeof name === 'string')
  } catch {
    return null
  }
  // 只认 dsh-memory 的基元工具面；没有它就不是 dsh-memory 提供方。
  if (!names.includes('cg') && !names.includes('stg')) return null
  return {
    name: PACKAGE_NAME,
    version: await installedVersion(),
    tools: names,
    smokePassed: false,
  }
}