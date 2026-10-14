// 生成「可安装测试候选包」：把本包打成 zip，并核对包内资源、入口、依赖与版本一致。
//
// 为什么要有脚本而不是手工压缩：手工压缩很容易把隔离实验根、node_modules、
// 临时产物一起打进去，或者让包内 package.json 版本与源码不一致。这里把「打什么」
// 「核对什么」都写成可重跑的代码，并输出一份清单供人工核对。
//
// 用法：
//   node scripts/pack-test-package.mjs            打包到 ../dist/
//   node scripts/pack-test-package.mjs --out <dir>
//
// 只读本包，只写输出目录；不安装、不启用、不推送、不动 release/。
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { ZipArchive } from './zip.mjs'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_OUT = path.resolve(PACKAGE_ROOT, '..', 'dist')

/** 打包内容：只放运行与自检需要的，明确排除隔离实验根、依赖与临时产物。 */
const INCLUDE_DIRECTORIES = ['src', 'test', 'scripts']
const INCLUDE_FILES = ['package.json', 'README.md', 'cordis.patch.yml']
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage'])
const EXCLUDED_FILE_PATTERNS = [/\.log$/, /\.tmp$/, /\.zip$/]

async function collectFiles(root, relative = '') {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
      files.push(...await collectFiles(root, childRelative))
      continue
    }
    if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue
    files.push(childRelative.split(path.sep).join('/'))
  }
  return files
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex === -1 ? DEFAULT_OUT : path.resolve(process.argv[outIndex + 1])

const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`package.json 版本不合法：${JSON.stringify(version)}`)

// 入口必须真实存在：装出来的包如果 main 指向不存在的文件，安装即失败。
const entry = path.join(PACKAGE_ROOT, manifest.main ?? 'src/index.mjs')
await stat(entry)

const files = []
for (const directory of INCLUDE_DIRECTORIES) files.push(...await collectFiles(PACKAGE_ROOT, directory))
files.push(...INCLUDE_FILES)
files.sort()

// 打包前自检：包里绝不能出现隔离实验根或依赖目录。
const forbidden = files.filter((file) => /(^|\/)(node_modules|\.memory-context-lab)(\/|$)/.test(file))
if (forbidden.length > 0) throw new Error(`包内出现禁止内容：${forbidden.join(', ')}`)

await mkdir(outDir, { recursive: true })
const archiveName = `${manifest.name}-v${version}-test-candidate.zip`
const archivePath = path.join(outDir, archiveName)
await rm(archivePath, { force: true })

const rows = []
const archive = new ZipArchive(createWriteStream(archivePath))
for (const file of files) {
  const bytes = await readFile(path.join(PACKAGE_ROOT, file))
  rows.push({ file, bytes: bytes.length, sha256: sha256(bytes) })
  archive.add(file, bytes)
}

// 清单**放进包里**：只把哈希打到 stdout，接收方拿到的 zip 就无法自证内容，
// 「包对应哪份源码」只能靠转述。清单列全部载荷文件，不含它自己（无法自指哈希），
// 也不含归档总字节数（那个数只能在清单写进去之后才知道，写进去就成了循环依赖）。
const manifestReport = {
  name: manifest.name,
  version,
  entry: manifest.main,
  entryExists: true,
  fileCount: rows.length,
  totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  peerDependencies: manifest.peerDependencies ?? {},
  files: rows,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifestReport, null, 2)}\n`, 'utf8')
archive.add('MANIFEST.json', manifestBytes)
await archive.finish()

// stdout 报告比包内清单多两项「写完才知道」的字段，供人工核对用。
const finalReport = {
  ...manifestReport,
  archive: archivePath,
  archiveBytes: (await stat(archivePath)).size,
  manifest: { file: 'MANIFEST.json', bytes: manifestBytes.length, sha256: sha256(manifestBytes) },
}
process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`)
