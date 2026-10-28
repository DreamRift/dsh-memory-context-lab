/**
 * T2 隔离环境定位（adapters/host，0.14.0-beta.35）。
 *
 * 只做「找得到 / 找不到」的只读判断，不启动进程、不签发凭据：
 * - `MEMORY_LAB_T2=0|false|off` 显式关闭；
 * - `MEMORY_LAB_T2_REPO` 显式指定 dsh-memory 包根（必须含 md_cg/mcp_server.py）；
 * - 否则从已安装的 `@furongjun1999/dsh-memory` 解析包根；
 * - Python 用 `MEMORY_LAB_T2_PYTHON` 覆盖，默认 `python`（Windows 与 POSIX 同）。
 *
 * 找不到不是错误：negotiate 会如实回落 T1，并把 reason 写进状态面。
 */
import { access, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@furongjun1999/dsh-memory'
const PACKAGE_SEGMENTS = ['@furongjun1999', 'dsh-memory']

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function packageRootOf(require, specifier) {
  try {
    const entry = require.resolve(specifier)
    // main 通常是 <pkg>/lib/index.js；包根 = 入口目录的上一级。也兼容入口就在包根。
    const candidate = dirname(dirname(entry))
    if (await exists(join(candidate, 'md_cg', 'mcp_server.py'))) return candidate
    const direct = dirname(entry)
    if (await exists(join(direct, 'md_cg', 'mcp_server.py'))) return direct
    return null
  } catch {
    return null
  }
}

async function versionOf(repoRoot) {
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/**
 * 从插件真实路径向上找 profile 的 node_modules。
 *
 * 为什么 `createRequire` 不够：装到 profile 后，本包真实路径在
 * `node_modules/.pnpm/dsh-memory-context-lab@file+.../node_modules/dsh-memory-context-lab`，
 * 而 `@furongjun1999/dsh-memory` 是 profile 的顶层依赖、**不是本包的依赖**——Node
 * 从本包真实路径向上解析时永远看不到它（实测 `resolveT2Isolated()` 返回 null，
 * 但 `MEMORY_LAB_T2_REPO` 一指定就正常）。所以补一条基于目录祖先的只读搜索：
 * 每一级都看 `node_modules/@furongjun1999/dsh-memory` 与 pnpm 的 hoisted 目录，
 * 命中标准是 `md_cg/mcp_server.py` 真实存在（不是只看目录名）。
 */
async function findPackageRootFromAncestors(startDirectory) {
  let current = startDirectory
  const root = parse(current).root
  for (;;) {
    const candidates = [
      join(current, 'node_modules', ...PACKAGE_SEGMENTS),
      join(current, ...PACKAGE_SEGMENTS),
      join(current, 'node_modules', '.pnpm', 'node_modules', ...PACKAGE_SEGMENTS),
    ]
    for (const candidate of candidates) {
      if (await exists(join(candidate, 'md_cg', 'mcp_server.py'))) return candidate
    }
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 从 DSH profile 找 dsh-memory（源码树运行脚本时的兜底）。
 *
 * 源码树不在任何 profile 的 node_modules 下面，单靠模块祖先永远找不到；
 * 但「本机哪个 profile 装了 dsh-memory」是 `$DSH_HOME/profiles/*` 的磁盘事实。
 * 优先 `DSH_PROFILE`，其次 desktop，再按名字排序；命中标准仍是 md_cg 真实存在。
 */
async function findPackageRootInProfiles(env) {
  const home = String(env.DSH_HOME ?? '').trim()
  if (home.length === 0) return null
  const profilesDir = join(home, 'profiles')
  let names = []
  try {
    names = await readdir(profilesDir, { withFileTypes: true })
      .then((rows) => rows.filter((row) => row.isDirectory()).map((row) => row.name))
  } catch {
    return null
  }
  const preferred = String(env.DSH_PROFILE ?? '').trim()
  const ordered = [...new Set([preferred, 'desktop', ...names].filter((name) => name.length > 0 && names.includes(name)))]
  for (const name of ordered) {
    const root = join(profilesDir, name)
    const candidates = [
      join(root, 'node_modules', ...PACKAGE_SEGMENTS),
      join(root, 'node_modules', '.pnpm', 'node_modules', ...PACKAGE_SEGMENTS),
    ]
    for (const candidate of candidates) {
      if (await exists(join(candidate, 'md_cg', 'mcp_server.py'))) return candidate
    }
  }
  return null
}

/**
 * 解析 T2 隔离后端的环境事实。
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env] 默认 process.env（测试注入）
 * @param {string} [deps.pythonOverride]
 * @returns {Promise<null | {repoRoot:string, python:string, version:string, source:string}>}
 *   null = 未配置/显式关闭/找不到；调用方按 T1 处理。
 */
export async function resolveT2Isolated({ env = process.env, pythonOverride } = {}) {
  const disabled = String(env.MEMORY_LAB_T2 ?? '').trim().toLowerCase()
  if (disabled === '0' || disabled === 'false' || disabled === 'off') return null

  const python = pythonOverride
    || String(env.MEMORY_LAB_T2_PYTHON ?? '').trim()
    || String(env.DSH_MEMORY_PYTHON ?? '').trim()
    || 'python'

  const explicit = String(env.MEMORY_LAB_T2_REPO ?? '').trim()
  if (explicit.length > 0) {
    if (!(await exists(join(explicit, 'md_cg', 'mcp_server.py')))) return null
    return { repoRoot: explicit, python, version: await versionOf(explicit), source: 'env' }
  }

  let repoRoot = null
  let source = 'installed'
  try {
    const require = createRequire(import.meta.url)
    repoRoot = await packageRootOf(require, PACKAGE_NAME)
  } catch {
    repoRoot = null
  }
  if (repoRoot === null) {
    repoRoot = await findPackageRootFromAncestors(dirname(fileURLToPath(import.meta.url)))
    source = 'profile'
  }
  if (repoRoot === null) {
    repoRoot = await findPackageRootInProfiles(env)
    source = 'profile-root'
  }
  if (repoRoot === null) return null
  return { repoRoot, python, version: await versionOf(repoRoot), source }
}