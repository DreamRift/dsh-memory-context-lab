#!/usr/bin/env node
/**
 * `npm test` 的前置检查：`test/` 目录必须存在（probe:host 也从 test/helpers 运行）。
 *
 * 背景（0.13.2 E-02）：发布包的 `files` 只有 `["src","scripts","README.md",
 * "CHANGELOG.md","cordis.patch.yml"]`，而这两个脚本都指向 `test/…`。在解包/安装后的
 * 目录里执行它们，得到的是：
 *
 *   Error: Cannot find module '…\package\test\batch-accounting.test.mjs'
 *
 * 一条 ModuleNotFound 既不像「这个包本来就不带测试」，也不告诉用户该去哪儿跑测试，
 * 很容易被当成包坏了。测试属于仓库、不属于包，所以这里给出明确结论并以非零退出，
 * 而不是让 Node 抛模块缺失。
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const testDir = path.join(root, 'test')

const exists = (() => {
  try {
    return statSync(testDir).isDirectory()
  } catch {
    return false
  }
})()

if (exists) process.exit(0)

console.error([
  '测试套件不在发布包里（0.13.2 E-02）：' + testDir + ' 不存在。',
  '测试属于仓库、不属于分发包。要跑测试请在源码树（plugin/ 或 release/ 的完整检出）里执行：',
  '  node scripts/test-all.mjs',
  '这不是安装损坏，也不需要修复包本身。',
].join('\n'))
process.exit(1)
