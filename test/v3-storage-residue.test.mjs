/**
 * 存储残留统计与清理守卫（0.15.4 问题 8，用户裁定 A+D）。
 *
 * ## 缺陷
 *
 * 插件替用户长期保管两类「不再有用、但不会被自动清掉」的东西，却**一个字都不说**：
 *
 * - `v3/sessions/<key>/quarantine/`——崩溃残留，设计上「只进不出，人工审计」，
 *   但没有任何命令能看大小、也没有出口能清。
 * - `v3/exports/`——本地导出包（含已归档正文与凭证正文首部），**无 TTL**。
 *
 * C-04 是同一件事的界面投影：面板只有一个「导出」按钮，不说明包含范围与清理方法。
 *
 * ## 用户裁定
 *
 * **A + D**：给命令出口（能清）+ `status` 如实报告（知道有多少）。
 * **不做 TTL 自动删**——自动删正文与「可恢复」的承诺相冲。
 *
 * ## 钉住的判据
 *
 * 1. `scanResidue` 必须**只读**（扫完文件还在），且两类分别计数；
 * 2. `cleanResidue` 的 `dryRun` 不得删任何文件（预览必须无副作用）；
 * 3. 真删只删这两类，**绝不碰** `records/` / 账本 / 索引——这是 A+D 的安全底线；
 * 4. 不跟随符号链接（防越界删除）；
 * 5. 报告与清理**同源**：`clean` 的删除集合必须来自同一次 `scanResidue`，
 *    否则会出现「status 报 3 个、clean 删 5 个」的自相矛盾账（计划 §10）；
 * 6. 统计失败如实上报，不猜成 0。
 *
 * ## 不适用条件
 *
 * - 不测 `status` 的排版（`v3-client-*` 与命令面守卫各管一段）。
 * - 不测 TTL 自动清理——**本版明确不做**，这条不做不是遗漏。
 * - 不测并发删除（单进程命令面串行调用）。
 *
 * ## 变异自证
 *
 * 让 `dryRun` 也真删 → 用例 2 红；让 `cleanResidue` 顺手删 records/ →
 * 用例 3 红。恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, lstat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cleanResidue, formatBytes, scanResidue } from '../src/v3/adapters/storage/storage-residue.mjs'

/** 造一个最小数据根：quarantine + exports + records + 账本。 */
async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcl-residue-'))
  const sessionKey = 'session-test-0001'
  const quarantine = path.join(root, 'sessions', sessionKey, 'quarantine')
  const records = path.join(root, 'sessions', sessionKey, 'records')
  const exports = path.join(root, 'exports')
  await mkdir(quarantine, { recursive: true })
  await mkdir(records, { recursive: true })
  await mkdir(exports, { recursive: true })
  await writeFile(path.join(quarantine, 'half.json'), 'x'.repeat(100))
  await writeFile(path.join(quarantine, 'nested.json'), 'y'.repeat(50))
  await writeFile(path.join(exports, 'bundle-1.json'), 'z'.repeat(2000))
  // 记录与账本是「绝不能被顺手删掉」的东西
  await writeFile(path.join(records, 'v3r-keep.json'), '{"id":"v3r-keep"}')
  await writeFile(path.join(root, 'sessions', sessionKey, 'vouchers.jsonl'), '{"v":1}\n')
  return { root, sessionKey, quarantine, records, exports }
}

test('问题 8：scanResidue 只读，且 quarantine 与 exports 分别计数', async () => {
  const { root, sessionKey, quarantine, exports } = await makeRoot()
  try {
    const scan = await scanResidue(root, sessionKey)
    assert.equal(scan.byKind.quarantine.files, 2, 'quarantine 应有 2 个文件')
    assert.equal(scan.byKind.quarantine.bytes, 150, 'quarantine 应为 100+50 字节')
    assert.equal(scan.byKind.exports.files, 1, 'exports 应有 1 个文件')
    assert.equal(scan.byKind.exports.bytes, 2000, 'exports 应为 2000 字节')
    assert.equal(scan.totalBytes, 2150, '合计必须与分类之和一致（同源）')
    // 只读：扫完文件必须还在
    assert.ok(existsSync(path.join(quarantine, 'half.json')), 'scanResidue 不得删除文件')
    assert.ok(existsSync(path.join(exports, 'bundle-1.json')), 'scanResidue 不得删除文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('问题 8：dryRun 预览必须零副作用（一个文件都不能删）', async () => {
  const { root, sessionKey, quarantine, exports } = await makeRoot()
  try {
    const preview = await cleanResidue(root, sessionKey, { dryRun: true })
    assert.equal(preview.removed, 3, '预览应报出 2 quarantine + 1 exports = 3 个')
    assert.ok(existsSync(path.join(quarantine, 'half.json')), 'dryRun 不得删除 quarantine 文件')
    assert.ok(existsSync(path.join(exports, 'bundle-1.json')), 'dryRun 不得删除 exports 文件')
    assert.equal(preview.failed.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('问题 8：真删只清 quarantine 与 exports，绝不动 records 与账本', async () => {
  const { root, sessionKey, quarantine, records, exports } = await makeRoot()
  try {
    const result = await cleanResidue(root, sessionKey, { dryRun: false })
    assert.equal(result.removed, 3, '应删除 3 个残留文件')
    assert.ok(!existsSync(path.join(quarantine, 'half.json')), 'quarantine 应被清空')
    assert.ok(!existsSync(path.join(quarantine, 'nested.json')), 'quarantine 嵌套文件也应清除')
    assert.ok(!existsSync(path.join(exports, 'bundle-1.json')), 'exports 应被清除')
    // 安全底线：记录与账本必须完好
    assert.ok(existsSync(path.join(records, 'v3r-keep.json')), 'records/ 绝不能被删除')
    assert.ok(
      existsSync(path.join(root, 'sessions', sessionKey, 'vouchers.jsonl')),
      '账本绝不能被删除',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('问题 8：不跟随符号链接（防越界删除）', async (t) => {
  const { root, sessionKey, quarantine } = await makeRoot()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mcl-outside-'))
  const victim = path.join(outside, 'important.txt')
  await writeFile(victim, 'do-not-delete')
  try {
    try {
      await symlink(outside, path.join(quarantine, 'link'), 'junction')
    } catch (error) {
      // Windows 无权限建链接是环境限制，不是本用例失败
      t.diagnostic('无法创建符号链接，跳越界用例：' + (error?.code ?? error))
      return
    }
    await cleanResidue(root, sessionKey, { dryRun: false })
    assert.ok(existsSync(victim), '符号链接目标绝不能被删（不跟随链接）')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('问题 8：kinds 过滤只清指定类别（同一趟扫描出数）', async () => {
  const { root, sessionKey, quarantine, exports } = await makeRoot()
  try {
    const result = await cleanResidue(root, sessionKey, { kinds: ['exports'], dryRun: false })
    assert.equal(result.removed, 1, '只应删 exports 的 1 个文件')
    assert.ok(!existsSync(path.join(exports, 'bundle-1.json')), 'exports 应被清除')
    assert.ok(existsSync(path.join(quarantine, 'half.json')), '限定 kinds 时 quarantine 必须保留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('问题 8：目录不存在时如实报 0，不抛错也不编造', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcl-empty-'))
  try {
    const scan = await scanResidue(root, 'session-nothing')
    assert.equal(scan.totalBytes, 0)
    assert.equal(scan.byKind.quarantine.files, 0)
    assert.equal(scan.byKind.exports.files, 0)
    const clean = await cleanResidue(root, 'session-nothing', { dryRun: false })
    assert.equal(clean.removed, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('问题 8：formatBytes 给人话体积，非法输入不编造', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(-1), '未知')
  assert.equal(formatBytes(Number.NaN), '未知')
})
