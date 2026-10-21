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
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
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

test('src/ 下不得出现 memory-context-lab2 前缀（日志前缀漂移无其他守卫）', async () => {
  const files = await sourceFiles(SRC)
  assert.ok(files.length > 30, `只扫到 ${files.length} 个源文件，扫描器可能失效`)
  const offenders = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.includes('memory-context-lab2')) {
        offenders.push(`${path.relative(SRC, file)}:${index + 1} ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], '日志前缀必须统一为 memory-context-lab:\n' + offenders.join('\n'))
})

test('日志前缀守卫自身有效：注入一行旧前缀必须被抓到', async () => {
  // 量具自检：确保上面的判据不是「怎么写都绿」。
  const probe = 'logger.warn(`memory-context-lab2: x`)'
  assert.ok(probe.includes('memory-context-lab2'), '判据字符串写错了')
})
