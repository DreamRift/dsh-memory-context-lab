/**
 * 0.13.1 F5：单回合长任务里的回注触发。
 *
 * 缺陷（实测会话 c1787f24）：1 个回合 120 步，全程没有第二次人类输入，
 * 自动回注 0 次，而同期归档了 59 个操作。模型只能自己回盘重读文件。
 *
 * 判据：回注触发不再只依赖「新的人类提示」，还必须能从**同一回合内部**
 * 识别出「模型正在重读某个文件」这一信号。
 *
 * 本守卫只断言触发判定的纯函数部分（`latestReadPathOf`）：
 *   - 认得出宿主的 `<path>…</path>` 正文头；
 *   - 认得出工具参数里的 `file_path` 字面量；
 *   - 取不到时返回 null（不猜）。
 *
 * 不适用条件与已知边界：本守卫不覆盖「触发后是否真的注入了内容」——那由
 * 检索面与 `autoRecall` 开关决定，属于 `v2-runtime.test.mjs` 的覆盖范围。
 * 本守卫绿不等于回注链路整体正确。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { latestReadPathOf } from '../src/v2/runtime.mjs'

test('F5a 识别宿主 read 工具的 <path> 正文头', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<path>C:\\work\\a.html</path>\n<type>file</type>' }] },
  ]
  const hit = latestReadPathOf(messages)
  assert.equal(hit?.path, 'C:\\work\\a.html')
})

test('F5b 识别工具调用参数里的 file_path 字面量', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: '{"file_path": "src/index.mjs", "offset": 1}' }] },
  ]
  assert.equal(latestReadPathOf(messages)?.path, 'src/index.mjs')
})

test('F5c 取最近一次读取（从尾部往前扫）', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<path>first.txt</path>' }] },
    { role: 'user', content: [{ type: 'text', text: '<path>second.txt</path>' }] },
  ]
  assert.equal(latestReadPathOf(messages)?.path, 'second.txt')
})

test('F5d 没有任何读取痕迹时返回 null（不猜）', () => {
  assert.equal(latestReadPathOf([]), null)
  assert.equal(latestReadPathOf(null), null)
  assert.equal(latestReadPathOf([{ role: 'user', content: [{ type: 'text', text: '普通提问，没有读文件' }] }]), null)
})

test('F5e 非文本块与畸形输入不抛错', () => {
  const messages = [
    { role: 'user', content: [{ type: 'image', attachment: { bytes: 1 } }] },
    { role: 'user' },
    null,
  ]
  assert.equal(latestReadPathOf(messages), null)
})
