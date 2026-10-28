/**
 * 宿主 range surfaceOp 守卫（M0/M2）：
 * - 区间 replace 必须覆盖全部被遮蔽 surface 节点；
 * - 单节点 replace 兼容既有卡片执行器；
 * - 确认面失败关闭；surfaceNodes/surfaceTextAt/eventTextAt/sessionInfo 可用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshHostAdapter } from '../src/v3/adapters/host/dsh-host.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

test('range replace：覆盖全部被遮蔽节点、活动面折叠成回执、正文可读', async () => {
  const session = createFakeSession({ cwd: 'C:\\ws' })
  session.pushContextWindow(100000)
  session.pushUser('u1')
  session.pushAssistant('a1')
  session.pushUser('u2')
  const host = createDshHostAdapter({ session, sessionKey: 's-range' })

  assert.deepEqual(await host.surfaceNodes(), [1, 2, 3])
  const { seq } = await host.surfaceOp({
    op: 'replace', startSeq: 1, endSeq: 2, sourceEventSeqs: [1, 2], text: '[回执] 归档 2 条',
  })
  assert.equal(seq, 4)
  assert.deepEqual(await host.surfaceNodes(), [4, 3])
  assert.equal(await host.surfaceTextAt(4), '[回执] 归档 2 条')
  assert.equal(await host.eventTextAt(2), 'a1')
  assert.deepEqual(await host.sessionInfo(), { sessionKey: 's-range', cwd: 'C:\\ws', contextWindow: 100000 })
})

test('range replace：漏掉被遮蔽节点必须失败关闭（不降级 append）', async () => {
  const session = createFakeSession()
  session.pushUser('u1')
  session.pushAssistant('a1')
  session.pushUser('u2')
  const host = createDshHostAdapter({ session, sessionKey: 's-range' })
  await assert.rejects(
    () => host.surfaceOp({ op: 'replace', startSeq: 0, endSeq: 1, sourceEventSeqs: [0], text: 'x' }),
    /未被遮蔽|sourceEventSeqs|覆盖/,
  )
  assert.deepEqual(await host.surfaceNodes(), [0, 1, 2], '失败后活动面不变')
})

test('单节点 replace 兼容：targetEventId 仍生成 start=end 的 surfaceOp', async () => {
  const session = createFakeSession()
  session.pushUser('u1')
  session.pushAssistant('a1')
  const host = createDshHostAdapter({ session, sessionKey: 's-range' })
  const { seq } = await host.surfaceOp({ op: 'replace', targetEventId: 1, text: '新卡' })
  assert.equal(seq, 2)
  assert.deepEqual(await host.surfaceNodes(), [0, 2])
  assert.deepEqual(session.log.at(-1).surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(session.log.at(-1).sourceEventSeqs, [1])
})

test('确认面失败：宿主未把新事件放进 surface 时失败关闭', async () => {
  const session = createFakeSession()
  session.pushUser('u1')
  session.pushAssistant('a1')
  const host = createDshHostAdapter({ session, sessionKey: 's-range' })
  const originalAppend = session.append
  session.append = (type, data, options) => {
    const result = originalAppend(type, data, options)
    session.surface.nodes = [1] // 模拟新回执没落面、原节点仍在
    return result
  }
  await assert.rejects(() => host.surfaceOp({ op: 'replace', targetEventId: 1, text: 'x' }), /未进入活动面|确认|面/)
})