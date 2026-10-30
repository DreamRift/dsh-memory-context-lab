/**
 * B3-25（AUD50-10-05）release↔plugin 文档差异白名单守卫。
 *
 * 事故面：发布流程曾把开发向 README/完整 CHANGELOG 推上公开面。这里钉住公开面
 * 策略的三条清单（见 docs/发布流程.md 第 5/6 步）：
 * ① release CHANGELOG 不得发明 plugin CHANGELOG 里不存在的版本节（滞后可以，超前/自创不行）；
 * ② release README 版本行与 release package.json 一致；
 * ③ 两份公开文档的相对链接只允许包内白名单目标——开发向内容（docs/、AGENTS、
 *    进展卡）不进公开面。
 *
 * 在 release/ 镜像内运行时 ../release 不存在，自动 skip（守卫只对源码线有意义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const releaseRoot = path.join(pluginRoot, '..', 'release')

// 公开文档允许的包内相对链接目标（发布包 files 集合内的文件）。
const LINK_WHITELIST = new Set(['./CHANGELOG.md', './LICENSE'])

async function exists(p) {
  try { await readFile(path.join(releaseRoot, p)); return true } catch { return false }
}

test('release 公开面文档差异白名单（B3-25）', { skip: !(await exists('package.json')) ? '../release 不存在（在 release 镜像内运行），守卫只在源码线执行' : false }, async () => {
  const [pluginChangelog, releaseChangelog, releaseReadme, releasePkg] = await Promise.all([
    readFile(path.join(pluginRoot, 'CHANGELOG.md'), 'utf8'),
    readFile(path.join(releaseRoot, 'CHANGELOG.md'), 'utf8'),
    readFile(path.join(releaseRoot, 'README.md'), 'utf8'),
    readFile(path.join(releaseRoot, 'package.json'), 'utf8'),
  ])

  // ① 版本节不得发明：release 的每个 ## 版本节都必须在 plugin CHANGELOG 里
  const pluginSections = new Set([...pluginChangelog.matchAll(/^## (0\S*?)(?:（|\s)/gm)].map((m) => m[1]))
  const releaseSections = [...releaseChangelog.matchAll(/^## (0\S*?)(?:（|\s)/gm)].map((m) => m[1])
  assert.ok(releaseSections.length > 0, 'release CHANGELOG 应有版本节（判据失效自检）')
  const invented = releaseSections.filter((s) => !pluginSections.has(s))
  assert.deepEqual(invented, [], 'release CHANGELOG 不得发明 plugin 没有的版本节：' + invented.join('、'))

  // ② README 版本行与清单一致
  const m = releaseReadme.match(/当前源码版本\s+(\S+?)（/)
  assert.ok(m, 'release README 版本行存在（含「当前源码版本」锚）')
  assert.equal(m[1], JSON.parse(releasePkg).version, 'release README 版本行必须与 release package.json 一致')

  // ③ 相对链接白名单：包外/开发向链接不进公开面
  const offenders = []
  for (const [name, body] of [['CHANGELOG.md', releaseChangelog], ['README.md', releaseReadme]]) {
    for (const link of body.matchAll(/]\(([^)]*)\)/g)) {
      const target = link[1]
      if (/^(https?:|#)/.test(target)) continue
      if (!LINK_WHITELIST.has(target)) offenders.push(name + ' → ](' + target + ')')
    }
  }
  assert.deepEqual(offenders, [], '公开文档出现白名单外的相对链接（包外链接是死链，开发向内容不进公开面）：\n' + offenders.join('\n'))
})
