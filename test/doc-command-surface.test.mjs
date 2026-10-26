/**
 * 0.13.1 守卫：文档与命令面不得漂移。
 *
 * ## 缺陷（本轮实测发现 4 处）
 * 1. plugin/README.md 的命令块漏了 recall 与 clean——而面板「清理」按钮和 off 的
 *    失败提示都把用户指向 /memory-lab clean confirm delete-session，唯一能救回死路
 *    的命令恰恰没写进安装文档。
 * 2. plugin/README.md 的 set 键位表停在 8 个键，实际有 13 个（漏 autorestore /
 *    readlease / protect / fullhistory / compress）。
 * 3. setSetting 的「未知设置项」错误提示是**手写字符串**，漏 autorestore：面板那个
 *    开关点下去回「未知设置项」，而提示列出的键位里也没有它——用户按提示逐个试都试不出来。
 * 4. 现行文档仍教用户敲 /memory-lab2 set fullhistory on（该命令 0.13.1 已删除），
 *    项目入口还写着「合并版 0.12.0、双引擎」。
 *
 * ## 判据
 * - SETTING_KEYS（runtime-settings.mjs）是键位唯一权威：帮助文本与 README 的键位表
 *   必须与它**集合相等**，错误提示必须由它派生。
 * - README 命令块里每行**第一个词**（子命令）必须有 dispatch case；preview|apply
 *   这类是参数，不参与比对。
 * - 现行文档（plugin/README.md、项目 README、docs/README.md）不得出现已删除的
 *   /memory-lab2；docs/降温模式.md 允许在带日期的历史小节里保留，但必须带版本口径横幅。
 *
 * ## 不适用条件与已知边界
 * 纯文本比对：证明「写的东西存在」，不证明描述与行为一致。参数级用法（clean
 * confirm delete-session）只校验子命令名。README 的命令块被解析成「行首 /memory-lab
 * 起头 + set 键位可折行」的形式，改写排版需要同步本文件。
 *
 * ## 运行
 * node --test-force-exit test/doc-command-surface.test.mjs；有漂移退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const PKG = path.join(HERE, '..')
const PROJECT = path.join(PKG, '..')
const DOCS = path.join(PROJECT, 'docs')

/** 从安装包（tgz 解压）里跑时没有上层文档：跳过而不假绿。 */
const skip = existsSync(DOCS) && existsSync(path.join(PROJECT, 'README.md'))
  ? false
  : '安装包内没有上层文档（只在开发树里跑）'

/** 以 LF 归一读取：本守卫按行首/代码块解析，CRLF 检出（Windows 默认 autocrlf=true）
 *  会让 ```text 块与行首匹配全部失效，造成“干净克隆必红”的假缺陷。 */
const readNormalized = async (file) => (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
const src = (rel) => readNormalized(path.join(SRC, rel))
const doc = (rel) => readNormalized(path.join(PROJECT, rel))

function settingKeys(source) {
  const m = /export const SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(m, 'runtime-settings.mjs 必须仍有 SETTING_KEYS 字面量（本守卫依赖该形态）')
  return new Set([...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]))
}

/** 解析 plugin/README.md 的第一个 text 代码块：子命令名与 set 键位。 */
function readmeSurface(markdown) {
  const text = String(markdown).replace(/\r\n/g, '\n')
  const block = /```text\n([\s\S]*?)```/.exec(text)
  assert.ok(block, 'plugin/README.md 必须仍有一个 text 代码块列出命令（本守卫依赖该形态）')
  const ops = new Set()
  const keys = new Set()
  let inSetTable = false
  for (const line of block[1].split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('/memory-lab ')) {
      const rest = trimmed.slice('/memory-lab '.length).trim()
      const head = rest.split(/\s/)[0]
      if (head) ops.add(head)
      inSetTable = head === 'set'
      if (inSetTable) {
        const tail = rest.slice(4).replace(/^<[^>]*>\s*<[^>]*>/, '')
        for (const m of tail.matchAll(/[a-z][a-z0-9]+/g)) keys.add(m[0])
      }
      continue
    }
    // 键位表可以折行（续行不以 /memory-lab 开头），折行同样计入。
    if (inSetTable && trimmed) {
      for (const m of trimmed.matchAll(/[a-z][a-z0-9]+/g)) keys.add(m[0])
      continue
    }
    if (!trimmed) inSetTable = false
  }
  return { ops, keys }
}

test('量具自检：读到了键位权威与 README 命令块', async () => {
  const keys = settingKeys(await src('v2/runtime-settings.mjs'))
  assert.ok(keys.size >= 12, 'SETTING_KEYS 只解析出 ' + keys.size + ' 个键，扫描器可能失效')
  assert.ok(keys.has('autorestore') && keys.has('protect'))
  const surface = readmeSurface(await readNormalized(path.join(PKG, 'README.md')))
  assert.ok(surface.ops.has('restore') && surface.ops.has('status'),
    'README 命令块解析失败：' + [...surface.ops].join(','))
})

test('帮助文本的键位表与 SETTING_KEYS 集合相等', async () => {
  const keys = settingKeys(await src('v2/runtime-settings.mjs'))
  const runtime = await src('v2/runtime.mjs')
  const start = runtime.indexOf('/memory-lab set <键> <值>')
  assert.ok(start > 0, 'V2_HELP 的 set 行必须仍存在')
  // 截到 cost 行的行首：该行本身不是键位（'cost' 是子命令名）。
  const costLine = runtime.indexOf('成本账本', start)
  const chunk = runtime.slice(start, runtime.lastIndexOf('\n', costLine))
  const listed = new Set([...chunk.matchAll(/[a-z][a-z0-9]+/g)].map((m) => m[0])
    .filter((k) => !['memory', 'lab', 'set'].includes(k)))
  const missing = [...keys].filter((k) => !listed.has(k))
  const extra = [...listed].filter((k) => !keys.has(k))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    '帮助文本与 SETTING_KEYS 不一致：缺 ' + missing.join(',') + ' 多 ' + extra.join(','))
})

test('README 的 set 键位表覆盖 SETTING_KEYS 全集', async () => {
  const keys = settingKeys(await src('v2/runtime-settings.mjs'))
  const surface = readmeSurface(await readNormalized(path.join(PKG, 'README.md')))
  const missing = [...keys].filter((k) => !surface.keys.has(k))
  assert.deepEqual(missing, [], 'plugin/README.md 的 set 键位表漏了：' + missing.join(','))
})

test('README 命令块里的每个子命令都在 dispatch 里有 case', async () => {
  const runtime = await src('v2/runtime.mjs')
  const cases = new Set([...runtime.matchAll(/case '([^']+)':/g)].map((m) => m[1]))
  const keys = settingKeys(await src('v2/runtime-settings.mjs'))
  const surface = readmeSurface(await readNormalized(path.join(PKG, 'README.md')))
  const dangling = [...surface.ops].filter((op) => !cases.has(op) && !keys.has(op) && op !== 'help')
  assert.deepEqual(dangling, [], 'README 写了没有实现的子命令：' + dangling.join(' / '))
})

test('未知设置项的错误提示由 SETTING_KEYS 派生', async () => {
  const settings = await src('v2/runtime-settings.mjs')
  assert.ok(settings.includes("SETTING_KEYS.join('|')"),
    '错误提示必须由 SETTING_KEYS 派生，否则删键/加键时又会漏')
})

test('现行文档不得再教用户敲已删除的 /memory-lab2', { skip }, async () => {
  for (const rel of ['plugin/README.md', 'README.md', 'docs/README.md']) {
    const text = await doc(rel)
    const hits = text.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('/memory-lab2') && !/删除|已收敛|不再|等价/.test(line))
    assert.deepEqual(hits.map(([n]) => n), [], rel + ' 仍引用已删除的 /memory-lab2（行号）')
  }
})

test('机制文档若保留历史命令名，必须带版本口径横幅', { skip }, async () => {
  const text = await doc('docs/降温模式.md')
  if (!text.includes('/memory-lab2')) return
  assert.ok(text.slice(0, 1500).includes('版本口径（0.13.1）'),
    'docs/降温模式.md 含 /memory-lab2 但缺少版本口径横幅')
})
