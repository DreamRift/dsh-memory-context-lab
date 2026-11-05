#!/usr/bin/env node
/**
 * P0 基线指纹（只读、可重复）：按 §11 口径计算 LF 归一后的树指纹。
 *
 * - 只读 git 对象，不读工作区脏文件：基线一律按指定提交（默认取 `baseline-freeze.mjs`
 *   的现行基线 ca1083a…）计算，避免「用当前脏树冒充已提交快照」；
 * - 历史快照 67e708c… 仍是可复算的旧基线（`node test/p0/fingerprint-baseline.mjs 67e708c…`），
 *   但不再是默认值：默认值必须与文档「现行基线」一致；
 * - 路径按相对路径升序；每文件取 blob，CRLF→LF 归一后参与 sha256；
 * - 输出 JSON 无时间戳、无绝对路径、无机器名；同提交在不同 cwd 逐字节相同。
 *
 * 用法：node test/p0/fingerprint-baseline.mjs [rev]   # 省略 rev = 现行基线
 * 退出码：0 成功 / 2 用法或 git 读取失败。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASELINE } from './baseline-freeze.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rev = process.argv[2] ?? BASELINE.commit
const roots = ['src', 'test', 'scripts', 'package.json']

function git(args) {
  return execFileSync('git', args, { cwd: pluginRoot, maxBuffer: 64 * 1024 * 1024 })
}

let commit
let tree
let manifest
let prefix
try {
  commit = git(['rev-parse', rev + '^{commit}']).toString('utf8').trim()
  tree = git(['rev-parse', commit + '^{tree}']).toString('utf8').trim()
  // cat-file 的 <rev>:<path> 以 cwd 为基准；本脚本允许从插件目录运行，统一补仓库内前缀。
  prefix = git(['rev-parse', '--show-prefix']).toString('utf8').trim()
  manifest = JSON.parse(git(['cat-file', 'blob', commit + ':' + prefix + 'package.json']).toString('utf8'))
} catch (error) {
  console.error('fingerprint-baseline: 无法读取基线提交（' + (error instanceof Error ? error.message : String(error)) + '）')
  process.exit(2)
}

// 不依赖 ls-tree 的 pathspec 收窄（该仓库形态下不稳定）：取全表后按相对路径尾段判定。
// 本仓的 ls-tree 输出在 Windows 下丢失中文前缀；同时按“尾段”生成两种候选，
// 逐个用 cat-file 探测，命中的那种再用于清单。
const allPaths = git(['ls-tree', '-r', '--name-only', '-z', commit])
  .toString('utf8').split('\0').filter((name) => name.length > 0)
const wanted = allPaths
  .filter((name) => /(^|\/)(src|test|scripts)\//.test(name) || /(^|\/)package\.json$/.test(name))
const resolveRepoPath = (name) => {
  const candidates = name.startsWith(prefix) ? [name] : [prefix + name, name]
  for (const candidate of candidates) {
    try {
      git(['cat-file', '-e', commit + ':' + candidate])
      return candidate
    } catch { /* 试下一种 */ }
  }
  throw new Error('基线提交里找不到路径：' + name)
}
const normalizeName = (repoPath) => (repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath)
const list = wanted.map((name) => {
  const repoPath = resolveRepoPath(name)
  return { name: normalizeName(repoPath), repoPath }
}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

const hashers = new Map(roots.map((root) => [root, createHash('sha256')]))
let files = 0
for (const { name, repoPath } of list) {
  const bytes = git(['cat-file', 'blob', commit + ':' + repoPath])
  const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  hashers.get('package.json').update(name).update('\0').update(normalized).update('\0')
  files += 1
  for (const root of roots) {
    if (root !== 'package.json' && name.startsWith(root + '/')) {
      hashers.get(root).update(name).update('\0').update(normalized).update('\0')
    }
  }
}

const fingerprints = {}
for (const [root, hasher] of hashers) fingerprints[root] = hasher.digest('hex').slice(0, 16)

const testFiles = list.filter(({ name }) => /^test\/[^/]+\.test\.mjs$/.test(name)).length
const p0Files = list.filter(({ name }) => name.startsWith('test/p0/')).length

process.stdout.write(JSON.stringify({
  schema: 'mcl-p0-baseline/1',
  commit,
  tree,
  manifest: { name: manifest.name, version: manifest.version },
  fingerprints,
  fingerprintAlgorithm: 'sha256(sorted(relPath + NUL + LF-normalized blob + NUL))[:16]',
  testSuite: { topLevelTestFiles: testFiles, p0FilesInCommit: p0Files },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
}, null, 2) + '\n')
