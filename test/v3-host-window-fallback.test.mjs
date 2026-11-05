/**
 * P3-09 宿主窗口回退 + 归档未知状态文案（0.15.1 §3.3）。
 *
 * ## 缺陷（两条，同一节）
 * 1. **`dsh-host.sessionInfo()` 遇到最近一条非法 `request/context` 就 break**：
 *    从新往旧扫，第一条 `request/context` 之后无条件跳出循环；只要最新那条的
 *    `contextWindow` 缺失/为 0/不是有限数，`contextWindow` 就是 `null`——更早那条
 *    完全有效的窗口被丢弃。后果：按步归档的占用 = latest/窗口 永不可判定 → 闸门永不开。
 * 2. **`archiveLine` 未知状态直出裸英文码**（`'归档：' + result.status`）：新增/内部状态
 *    会在用户命令面显示成不可读的英文标识符，且看不出「是不是可重试的失败」。
 *
 * ## 判据来源
 * `src/v3/adapters/host/dsh-host.mjs`（最近一条**有效**窗口）、
 * `src/index.mjs` 的 `archiveLine`（未知状态给出可执行文案并保留原始码）。
 *
 * ## 断言组
 * A. 最新一条非法、更早一条有效 → 取更早那条（旧实现返回 null → 红）；
 * B. 全部非法 → null（不猜、不回落默认窗口）；
 * C. 多条有效 → 取**最新**那条（语义仍是「最近的有效窗口」）；
 * D. archiveLine 未知状态 → 中文明文 + 括号里保留原始码，且不含「已归档」误导。
 *
 * ## 不适用条件与已知边界
 * - 只影响读取「窗口大小」的回退顺序；不改 `request/context` 的写入、不补造窗口值；
 * - `contextWindow` 仍要求有限正数（字符串/0/负数一律视为不合法，继续往前找）；
 * - archiveLine 的既有分支一字未改，只替换了「未知状态」这一条兜底。
 *
 * ## 定点变异自证（`node --test test/v3-host-window-fallback.test.mjs`）
 * - 把 dsh-host 的循环改回「遇到第一条 request/context 就 break」→ A 组红；
 * - 把 archiveLine 的兜底改回 `'归档：' + result.status` → D 组红；
 * - 恢复后 4 组全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshHostAdapter } from '../src/v3/adapters/host/dsh-host.mjs'
import { archiveLine } from '../src/index.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

test('P3-09-A 最新一条窗口非法时回退到更早的有效值（旧实现返回 null → 红）', async () => {
  const session = createFakeSession({ cwd: 'C:\\ws' })
  session.pushContextWindow(100000) // 有效
  session.pushContextWindow(null) // 最新那条非法
  const host = createDshHostAdapter({ session, sessionKey: 's-win' })
  const info = await host.sessionInfo()
  assert.equal(info.contextWindow, 100000, '必须回退到更早那条有效窗口（按步闸门要靠它）')
})

test('P3-09-B 全部窗口非法：null，不猜默认值', async () => {
  const session = createFakeSession()
  session.pushContextWindow(0)
  session.pushContextWindow(-5)
  session.pushContextWindow('128000')
  const host = createDshHostAdapter({ session, sessionKey: 's-win2' })
  const info = await host.sessionInfo()
  assert.equal(info.contextWindow, null, '没有任何有效窗口时必须如实 null（不得回落默认）')
})

test('P3-09-C 多条有效：取最新那条（语义仍是「最近的有效窗口」）', async () => {
  const session = createFakeSession()
  session.pushContextWindow(100000)
  session.pushContextWindow(200000)
  const host = createDshHostAdapter({ session, sessionKey: 's-win3' })
  assert.equal((await host.sessionInfo()).contextWindow, 200000)
  // 夹一条非法在中间，仍然是取后出现的那条有效值
  session.pushContextWindow(null)
  assert.equal((await host.sessionInfo()).contextWindow, 200000)
})

test('P3-09-D archiveLine 未知状态：中文明文 + 保留原始码，不说成已归档', () => {
  const line = archiveLine({ status: 'store-rejected' })
  assert.equal(/归档：store-rejected$/.test(line), false, '不得直出裸英文码（旧实现就是这行文本）')
  assert.match(line, /未知状态/, '必须明确是未知状态')
  assert.match(line, /store-rejected/, '原始码要保留（可取证，不静默吞掉）')
  assert.equal(line.includes('已归档'), false, '未知状态不得说成已归档')
  // 既有分支不得被这条兜底影响
  assert.match(archiveLine({ status: 'paused' }), /暂停归档/)
  assert.match(archiveLine({ status: 'archive-busy' }), /正在归档中/)
  assert.match(archiveLine({ status: 'no-candidate' }), /暂无可归档/)
})
