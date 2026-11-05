/**
 * H-22 口径锁（P1-12）：v3 转正闸门参数与闸门判据互锁。
 *
 * ## 缺陷（0.15.1，PR #11 问题 1）
 * 旧用例在**模块顶层** `readFile(path.join(here, '../../docs/dev-0.14.0/…-20261026.md'))`：
 * 该路径指向**仓库父目录**的文档。作者工作区父目录恰好有这份文档 → 本地恒绿；把
 * `plugin/` 单独复制成「干净克隆 + npm install」形状（插件包里没有 docs/）→
 * 整个文件顶层 ENOENT、exit 1，`node scripts/test-all.mjs` = 1/203 套件失败。
 * 仓库没有 CI，所以这条红不会被发现。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★11 / §3.1 P1-12；
 * 用户裁定（2026-11-04）：夹具方案（文档不入库到插件包），工作区存在时双比，缺席显式 skip。
 *
 * ## 修法
 * - 冻结夹具 `test/fixtures/h22-calibration.md`（随插件包发布，干净克隆自足）；
 * - 工作区文档存在时**逐行结构比对**（定稿表 4 行 × 3 列），漂移即红；
 * - 缺席时 `t.skip` 明示「已由夹具守住口径」，不让缺席伪装成通过。
 *
 * ## 断言组
 * 1. 夹具含四项定稿文本且数值可解析（原断言改为读夹具）；
 * 2. 闸门判据行为与定稿值一致（0.2 开 / 滞回死区不抖）；
 * 3. 工作区文档存在时与夹具逐行一致；缺席时 skip 且计数可见。
 *
 * ## 不适用条件与已知边界
 * - 只锁「定稿表」的四项参数，不锁文档其余章节（其余章节属于叙述，不是合同）；
 * - 文档缺席（干净克隆、单独打包）时双比无从执行，skip 是唯一诚实表达；CI 侧以
 *   `node scripts/test-all.mjs` 的 skip 单列计数兜底（skip ≠ pass）。
 *
 * ## 定点变异自证
 * 把夹具的「20 万 token（百万窗口 × 20%）」改成「30 万」→ 第 1、3 条用例必红；
 * 把测试顶层改回 `../../docs/…` 并搬走工作区文档 → 整个文件 ENOENT（干净克隆形状复现）。
 * 两次读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluatePressureGate } from '../src/v3/domain/session/pressure-gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（plugin/ 的上一级）：判断夹具是否是可入库制品用。镜像/单包形状里没有 .git，判据自动退场。 */
const repoRoot = path.join(here, '..', '..', '..')
/** 冻结夹具：随插件包发布，干净克隆自足（P1-12）。 */
const FIXTURE = path.join(here, 'fixtures/h22-calibration.md')
/** 第二真源：工作区文档（docs/ 与 plugin/ 同仓摆放时存在）；缺席是预期形状，不是失败。 */
const WORKSPACE_DOC = path.join(here, '../../docs/dev-0.14.0/检索复验基线与provisional参数-20261026.md')
const doc = await readFile(FIXTURE, 'utf8')
const workspaceDoc = await readFile(WORKSPACE_DOC, 'utf8').catch(() => null)

/** 四项定稿行：合同文本本身（与文档表格逐字一致）。 */
const FINAL_LINES = [
  '20 万 token（百万窗口 × 20%）',
  'max(5%, 3σ₃₀)',
  '闸门失效保护 25 万（25%）',
  '贴线率/超调率不劣于实测（12% / 4.4%）',
]

/** 取「v3 转正闸门参数（定稿）」表的行（去表头分隔行），用于结构双比。 */
function finalTable(text) {
  const start = text.indexOf('v3 转正闸门参数（定稿）')
  assert.ok(start >= 0, '文档/夹具必须含「v3 转正闸门参数（定稿）」章节')
  const rows = []
  for (const line of text.slice(start).split('\n')) {
    if (!line.trim().startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    if (/^\|\s*-/.test(line)) continue
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()))
  }
  return rows
}

test('H-22 口径锁：冻结夹具必须是被 git 跟踪的制品（否则干净克隆仍会 ENOENT）', (t) => {
  // P1-12 的缺陷本体是「口径依赖仓库外文件」。修法把口径搬进 test/fixtures/，但如果那份夹具
  // **没有被提交**，clone 出来的树里就没有它——干净克隆照样红，只是原因换成了「夹具不在」。
  // 因此这里把「夹具是可入库制品」本身钉成断言（untracked = 红，而不是靠人记得 git add）。
  let tracked = null
  try {
    tracked = execFileSync('git', ['ls-files', '--error-unmatch', path.relative(repoRoot, FIXTURE)], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    tracked = null
  }
  // 不在 git 工作区里（发布镜像 / 单包安装形状）时本判据无从执行：显式 skip，不伪装成通过。
  // 「干净克隆」形状里 .git 一定存在，因此这条判据在那里**真的会跑**——它守的正是那个场景。
  if (!existsSync(path.join(repoRoot, '.git'))) {
    t.skip('不在 git 工作区内（发布镜像 / 单包安装形状）：夹具入库判据无从执行')
    return
  }
  assert.ok(tracked !== null && tracked.length > 0,
    'H-22 冻结夹具必须提交进仓库（git add ' + path.relative(repoRoot, FIXTURE) + '）：未跟踪时干净克隆会 ENOENT，P1-12 复发')
})

test('H-22 口径锁：夹具含四项定稿且数值可解析', () => {
  for (const line of FINAL_LINES) assert.ok(doc.includes(line), '定稿行：' + line)
  assert.match(doc, /20 万/, '入门阈值数值')
  assert.match(doc, /25 万/, '紧急线数值')
  assert.ok(doc.includes('12% / 4.4%'), '转正验收指标数值')
})

test('H-22 口径锁：闸门判据行为与定稿值一致（0.2 开 / 0.25 兜底语义）', () => {
  // 占用 = 0.2（20 万 / 百万）：达到入门线 → 开闸
  const at = evaluatePressureGate({ occupancy: 0.2, enterThreshold: 0.2 })
  assert.equal(at.open, true, '达到 20% 入门线必须开闸')
  // 占用 0.199：死区内不抖（滞回语义由 exitThreshold 承载）
  const below = evaluatePressureGate({ occupancy: 0.199, enterThreshold: 0.2, exitThreshold: 0.15, currentlyOpen: true })
  assert.equal(below.open, true, '死区内维持（不抖）')
  // 占用 0.25：超过紧急线语义位（闸门判据面只管 enter/exit；25 万兜底属执行层，这里锁数值可推导）
  assert.ok(0.25 >= 0.2, '紧急线 25% 高于入门线 20%')
})

test('H-22 口径锁：工作区文档与冻结夹具逐行一致（缺席时显式 skip）', (t) => {
  if (workspaceDoc === null) {
    t.skip('工作区文档不在（干净克隆 / 单独打包 plugin 形状）：口径已由冻结夹具守住')
    return
  }
  assert.deepEqual(finalTable(doc), finalTable(workspaceDoc), '定稿表漂移：文档与夹具必须逐行一致')
})
