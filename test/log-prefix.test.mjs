/**
 * 0.13.2 守卫：日志前缀必须统一为 `memory-context-lab:`（E-03）。
 *
 * ## 缺陷
 * `runtime-lifecycle.mjs` 里残留 1 处 `memory-context-lab2: restore guard unavailable:`，
 * 而 release notes 声称「已统一」。更根本的问题是：**没有任何测试覆盖日志前缀**，
 * 所以这句话没人验证过——前缀漂移只会让运维按 `memory-context-lab` 过滤日志时漏掉
 * 那几行，属于典型的「没人看就没人发现」。
 *
 * ## 判据（改回去必红）
 * `src/` 下（含 `src/v2/`）任何文件都不得出现 `memory-context-lab2`。
 *
 * ## 量具自检（T5，2026-11-04 审计）
 * 旧「自检」只断言一个写死的字符串包含 `memory-context-lab2`——不写文件、不跑扫描器，
 * 怎么写都绿（恒真假绿）。现在把扫描器抽成可注入目录的函数，自检**真的造一个含旧前缀
 * 的临时源文件**并跑同一扫描器：扫不到就是量具坏了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await sourceFiles(target))
      continue
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue
    out.push(target)
  }
  return out
}

/** 扫描任意目录：返回 { count, offenders }。生产判据与自检共用这一份。 */
async function scanPrefix(root) {
  const files = await sourceFiles(root)
  const offenders = []
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.includes('memory-context-lab2')) {
        offenders.push(path.relative(root, file) + ':' + (index + 1) + ' ' + line.trim())
      }
    }
  }
  return { count: files.length, offenders }
}

test('src/ 下不得出现 memory-context-lab2 前缀（日志前缀漂移无其他守卫）', async () => {
  const { count, offenders } = await scanPrefix(SRC)
  assert.ok(count > 30, `只扫到 ${count} 个源文件，扫描器可能失效`)
  assert.deepEqual(offenders, [], '日志前缀必须统一为 memory-context-lab:\n' + offenders.join('\n'))
})

test('日志前缀守卫量具自检：注入旧前缀的临时源文件必须被抓到', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-log-prefix-'))
  try {
    await writeFile(path.join(dir, 'good.mjs'), 'logger.warn("memory-context-lab: ok")\n', 'utf8')
    await writeFile(path.join(dir, 'bad.mjs'), 'logger.warn("memory-context-lab2: drift")\n', 'utf8')
    const { count, offenders } = await scanPrefix(dir)
    assert.equal(count, 2)
    assert.equal(offenders.length, 1, '含旧前缀的文件必须被扫描器抓到：' + offenders.join('；'))
    assert.match(offenders[0], /^bad\.mjs:1 /)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
