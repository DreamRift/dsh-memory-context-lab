/**
 * 0.14.0-beta.46：判负（not-worth）的按步 span 不得永久堵死队头。
 *
 * 真实会话 55cc43c5 的停摆链：seq 930–946（3 步）的记录正文只有 105 字（assistant
 * 消息 metaOnly、payload.text 为空），回执 186 字 → makePlan 判 not-worth；而
 * selectStepSpan 永远从最老 span 开始、archiveStepOnce 遇到 not-worth 直接返回，
 * 于是后面 119 步 / 50 个请求零归档。
 *
 * 修法边界：只跳过「净收益为负」的 span（非安全边界），pin / 未完成工具对 / 无记录
 * 仍由选择器照常 break；判负 span 保持在活动面上，不被误压。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** 记录正文只有「ok」的步骤：assistant 消息无 text 块（metaOnly）+ 工具结果 2 字。 */
function pushTinyStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  const assistant = session.append('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + index, name: 'run', arguments: '{"code":"1"}' }] },
  })
  const result = session.append('tool/result', {
    message: { role: 'tool', toolCallId: 'c' + index, content: [{ type: 'text', text: 'ok' }] },
  })
  session.append('step/end', { turn: 1, step: index })
  return { assistant: assistant.seq, result: result.seq }
}

/** 正文远大于回执的大步骤。 */
function pushBigStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(200))
  session.append('step/end', { turn: 1, step: index })
}

test('not-worth 队头不再堵死归档：跳过判负 span，后续 span 照常压', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-not-worth-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-not-worth-head'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    session.pushUser('开始')
    const tiny = []
    for (let index = 1; index <= 3; index += 1) tiny.push(pushTinyStep(session, index))
    for (let index = 4; index <= 13; index += 1) pushBigStep(session, index)

    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    const usageDir = path.join(root, 'sessions', id)
    await mkdir(usageDir, { recursive: true })
    await writeFile(path.join(usageDir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')

    const tinyEnd = tiny[tiny.length - 1].result

    // 预览与执行同一游标：不能把「下一次归档」报成一个永远压不了的判负 span。
    const preview = await engine.dryRunArchive(id, session, {})
    assert.equal(preview.status, 'planned', '预览必须越过判负队头：' + JSON.stringify(preview))
    assert.ok(preview.startSeq > tinyEnd, '预览应从判负 span 之后开始')

    const first = await engine.archiveForStep(id, session, {})
    assert.equal(first.status, 'archived', '判负队头不得让整步返回 not-worth：' + JSON.stringify(first))
    assert.ok(first.startSeq > tinyEnd, '归档必须从判负 span 之后开始')
    assert.equal((await engine.historyOf(id)).total, 1)
    assert.ok((await session.surface.nodes).includes(tiny[0].assistant), '判负 span 必须留在活动面上（不能被误压）')

    const second = await engine.archiveForStep(id, session, {})
    assert.equal(second.status, 'archived', '后续 span 必须继续归档，而不是永久停摆：' + JSON.stringify(second))
    assert.ok(second.startSeq > first.endSeq, '第二段必须接在第一段之后')
    assert.equal((await engine.historyOf(id)).total, 2)
    assert.equal(ctx.warnings.length, 0, '归档不得告警失败：' + ctx.warnings.join(' | '))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
