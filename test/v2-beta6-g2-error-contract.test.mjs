/**
 * 0.13.2-beta.6 守卫（一）：统一错误契约（G2 根因组）。
 *
 * 判据不是「某个文件里没有 throw new Error」，而是**三条用户/审计能看到的后果**：
 *   1. 对外错误必须带 code：调用方（宿主、命令面、审计）靠 code 分支，裸 Error 的
 *      code 恒 undefined，等于「所有失败都是同一种失败」。
 *   2. 静态守卫：src/ 下不得新增裸 `throw new Error` / `throw new TypeError`——
 *      这是防复发的唯一硬保证，靠人记不住。
 *   3. V2SessionStateDamagedError 自己也要带 code：它是错误基类的用户，不是例外。
 *
 * 之所以写成「静态扫描 + 行为断言」两条腿：只做行为断言会漏掉未被测试触达的分支，
 * 只做静态扫描会允许「有 code 但没被抛过」的死路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DamagedError, EngineV2Error, InvalidArgumentError } from '../src/errors.mjs'
import { V2SessionStateDamagedError } from '../src/v2/state.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function listSourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)))
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

test('G2：src/ 下不存在裸 throw new Error / TypeError（统一错误基类是唯一出口）', async () => {
  const offenders = []
  for (const file of await listSourceFiles(SRC)) {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/^\s*(?:\/\/|\*)/.test(line)) return
      if (/throw\s+new\s+(?:Error|TypeError|RangeError)\s*\(/.test(line)) {
        offenders.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `这些位置仍在抛裸错误，调用方拿不到 code：\n${offenders.join('\n')}`)
})

test('G2：错误家族都带 code，且 code 是稳定的大写标识', () => {
  const cases = [
    new EngineV2Error('boom', { code: 'EENGINE' }),
    new InvalidArgumentError('boom'),
    new DamagedError('boom'),
  ]
  for (const error of cases) {
    assert.equal(typeof error.code, 'string')
    assert.match(error.code, /^E[A-Z0-9_]+$/)
    assert.ok(error instanceof Error)
    assert.ok(error instanceof EngineV2Error, '子类必须能被统一 catch 住')
  }
})

test('G2：未显式给 code 时仍有默认 code（不得回落 undefined）', () => {
  const error = new EngineV2Error('boom')
  assert.equal(typeof error.code, 'string')
  assert.notEqual(error.code, undefined)
})

test('G2：V2SessionStateDamagedError 带 code（状态文件损坏是可分支的业务错误）', () => {
  const error = new V2SessionStateDamagedError('坏掉了')
  assert.equal(typeof error.code, 'string')
  assert.match(error.code, /^E[A-Z0-9_]+$/)
  assert.ok(error instanceof EngineV2Error, '状态损坏错误必须能被统一 catch 住')
})
