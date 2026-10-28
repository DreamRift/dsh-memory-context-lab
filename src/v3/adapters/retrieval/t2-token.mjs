/**
 * T2 隔离凭据（adapters/retrieval，0.14.0-beta.35）。
 *
 * 目标不是「复用全局灵枢凭据」，而是**完全隔离**：
 * - 令牌库放在会话隔离根内的 `tokens.json`；
 * - 签发时显式传 `--token-file`，启动 MCP 时传 `MDCG_TOKEN_FILE`；
 * - 明文令牌只写隔离根内的 `t2-token`（0600 尽力而为），不进日志、不进导出。
 *
 * 签发角色是 `designer`：隔离根需要 `write` + `read` + `forget`（本地遗忘要同步
 * 清掉镜像）；`recorder` 没有 `forget`，实测只能写不能删。权限上限仍只作用于
 * **本会话的隔离根**，不是全局灵枢；越权写入在这里没有可触达的正式数据。
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 隔离令牌文件名（与 `tokens.json` 区分：一个是明文，一个是哈希库）。 */
export const T2_TOKEN_PLAINTEXT_FILE = 't2-token'
export const T2_TOKEN_STORE_FILE = 'tokens.json'

function parseIssued(stdout) {
  const text = String(stdout ?? '').trim()
  if (text.length === 0) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.token === 'string') return parsed
  } catch { /* 非纯 JSON 时按行扫描 */ }
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.token === 'string') return parsed
    } catch { /* 继续找下一行 */ }
  }
  return null
}

async function writePrivate(file, content) {
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 })
  try { await chmod(file, 0o600) } catch { /* Windows 上 chmod 可能不生效；不把它当失败 */ }
}

/**
 * 确保隔离根里有一枚可用的 recorder 令牌。
 *
 * @param {object} deps
 * @param {string} deps.root 隔离根（t2-mdcg）
 * @param {string} deps.repoRoot dsh-memory 包根
 * @param {string} deps.python
 * @param {Record<string,string|undefined>} [deps.env]
 * @returns {Promise<{token:string, tokenFile:string, tokenStoreFile:string, issued:boolean}>}
 */
export async function ensureT2Token({ root, repoRoot, python = 'python', env = process.env } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('t2-token: root 必传')
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('t2-token: repoRoot 必传')
  await mkdir(root, { recursive: true })
  const tokenFile = join(root, T2_TOKEN_PLAINTEXT_FILE)
  const tokenStoreFile = join(root, T2_TOKEN_STORE_FILE)

  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim()
    if (existing.startsWith('mdcg1.')) return { token: existing, tokenFile, tokenStoreFile, issued: false }
  } catch { /* 不存在/不可读 → 重新签发 */ }

  const childEnv = {
    ...process.env,
    ...env,
    PYTHONPATH: repoRoot,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    MDCG_TOKEN_FILE: tokenStoreFile,
  }
  let stdout = ''
  try {
    const result = await execFileAsync(python, [
      '-X', 'utf8', '-m', 'md_cg.tokens',
      // `--token-file` 是**顶层**参数（argparse 的 subparser 不认），必须放在 issue 之前。
      '--token-file', tokenStoreFile,
      'issue',
      '--role', 'designer',
      '--actor', 'mcl-t2',
      '--clearance', 'internal',
    ], {
      cwd: repoRoot,
      env: childEnv,
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    const detail = String(error?.stderr ?? '').trim().slice(0, 500)
    throw new Error('t2-token: 签发隔离令牌失败：' + (detail || error?.message || String(error)))
  }
  const issued = parseIssued(stdout)
  if (issued === null || typeof issued.token !== 'string' || !issued.token.startsWith('mdcg1.')) {
    throw new Error('t2-token: 签发命令没有返回可解析的令牌（拒绝把未知输出当凭据）')
  }
  await writePrivate(tokenFile, issued.token + '\n')
  return { token: issued.token, tokenFile, tokenStoreFile, issued: true }
}

/** 只读诊断：不返回令牌明文。 */
