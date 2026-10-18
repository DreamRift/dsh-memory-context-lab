#!/usr/bin/env node
/**
 * 逐文件跑全部测试并汇总失败，不因第一套失败而中断。
 *
 * `npm test` 的 `&&` 链适合快速失败，但它会让第 7 套一红就掩盖其余套件的状态；
 * 发布前的门禁需要「跑完再汇总」。两者都保留：日常用 npm test，收尾用 test:all。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const testDir = path.join(root, 'test')
const files = readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).sort()
const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test-force-exit', path.join(testDir, file)], { stdio: 'inherit' })
  if (result.status !== 0) failures.push({ file, status: result.status ?? 'signal' })
}
console.log('')
if (failures.length === 0) {
  console.log(`全部 ${files.length} 套件通过。`)
  process.exit(0)
}
console.error(`${failures.length}/${files.length} 套件失败：`)
for (const failure of failures) console.error(`- ${failure.file}（exit ${failure.status}）`)
process.exit(1)
