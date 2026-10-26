import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// H-12 版本守卫：manifest 与 README 版本行必须一致（README_VERSION_DRIFT 回归）
// 版本单一真源是 package.json；README 版本行是面向用户的判断依据，漂移 = 错误事实。
test('README 版本行与 package.json 一致（版本漂移守卫）', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  const readme = await readFile(path.join(dir, 'README.md'), 'utf8')
  const m = readme.match(/当前源码版本\s+(\S+?)（/)
  assert.ok(m, 'README 版本行存在（含「当前源码版本」锚）')
  assert.equal(m[1], pkg.version, 'README 版本行必须与 package.json 一致，否则用户按 README 判断版本会错')
})
