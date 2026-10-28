import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { RECALL_PACK_MAX_CHARS, RECALL_RESULT_MIN_SCORE } from '../src/v3/application/recall.mjs'

/**
 * 设置极值不得让回注功能性失效（H-97/H-98/H-99 的守卫）。
 *
 * 三个缺陷的共同形态：**参数在 Schema 与设置页里都合法**，但下游用例另有隐含前提
 * （两面阈值必须成对、热路径不得重建、首部长度上限等于整包硬顶）。用户拖动一个控件，
 * 功能整体失效，而观察面只显示「失败 N 次」或「预算被固定行占满」——看起来像环境问题。
 *
 * 每条都用**真实入口**（attachV3Engine + 真实 pre-step 钩子 + recallForInjection）验证：
 * 另开句柄直接写库会绕过引擎的 runtimes 表，回注恒 no-session，缺陷就测不到了。
 */

const memEvent = (seq, text) => ({
  type: 'user/message', seq, time: 1,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

const sessionId = 'sess-settings'

/**
 * 建一个装配了 v3 引擎的会话，并用**真实的 pre-step 钩子**把给定事件喂进去。
 * @param texts 人类输入正文列表（按 seq 顺序）
 * @param run 断言体，拿到 engine / sessionId / root
 */
async function withEngine(texts, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-settings-'))
  const listeners = []
  const ctx = { on: (event, handler) => { listeners.push({ event, handler }); return () => {} }, logger: { warn() {}, info() {} } }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const log = texts.map((text, seq) => memEvent(seq, text))
    const session = { id: sessionId, log, append: () => ({ seq: 1 }), surface: { nodes: [] } }
    for (const { handler } of listeners.filter((row) => row.event === 'agent/pre-step')) {
      await handler({ agent: { session }, turn: 1, step: 1, signal: { aborted: false }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    }
    await engine._waitForIdle()
    await run({ engine, sessionId, root })
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('装包阈：设置页允许 0（文案「0 表示不过滤」）时回注必须仍然注入', async () => {
  await withEngine(['数据库连接池的配置参数说明'], async ({ engine, sessionId }) => {
    // 旧实现只透传 packMinScore，用例内 resultMinScore 固定 0.01 →
    // applyMinScore 抛「装包面阈只得更严」，每步回注都判 failed。
    const out = await engine.recallForInjection(sessionId, '数据库连接池配置', {
      turn: 1, limit: 10, packMinScore: 0, previewChars: 160, queryMaxChars: 512,
    })
    assert.equal(out.status, 'injected', '装包阈 0 是合法配置，回注不得整体失效：' + (out.reason ?? out.error?.message ?? ''))
    assert.ok(out.text.length > 0)
  })
})

test('装包阈：介于 0 与结果面下限之间的值同样必须注入', async () => {
  await withEngine(['缓存穿透与雪崩的处置方案'], async ({ engine, sessionId }) => {
    // 0 < 0.005 < RECALL_RESULT_MIN_SCORE：只透传 packMinScore 时同样会抛错。
    const out = await engine.recallForInjection(sessionId, '缓存穿透雪崩', {
      turn: 1, limit: 10, packMinScore: RECALL_RESULT_MIN_SCORE / 2, previewChars: 160, queryMaxChars: 512,
    })
    assert.equal(out.status, 'injected', '结果面下限必须随装包阈一起降：' + (out.reason ?? out.error?.message ?? ''))
  })
})

test('首部长度：设置页上界（等于整包硬顶）时回注必须仍然注入', async () => {
  await withEngine(['数据库连接池配置参数说明'.repeat(200)], async ({ engine, sessionId }) => {
    const out = await engine.recallForInjection(sessionId, '数据库连接池配置参数', {
      turn: 1, limit: 10, packMinScore: 0.5, previewChars: RECALL_PACK_MAX_CHARS, queryMaxChars: 512,
    })
    assert.equal(out.status, 'injected', 'previewChars 处于允许上界时回注不得退化成纯壳：' + (out.reason ?? out.error?.message ?? ''))
    assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS, '硬顶仍必须成立：' + out.text.length)
  })
})

test('热路径：索引被删（陈化到不存在）时如实回 skipped，且绝不重建', async () => {
  await withEngine(['初次摄入尚未建索引'], async ({ engine, sessionId, root }) => {
    const idx = path.join(root, 'sessions', sessionId, 'lexical-index.json')
    // 删掉索引模拟「防抖窗口内 / 崩溃后索引丢失」的形态（首次摄入已建，这里刻意抹掉）。
    // 旧实现 freshIndex 里 \`!allowRebuild && index !== null\` 的 index 判据让
    // 索引缺失从后门落进重建分支——热路径做 O(N) 全量活（实测 645ms）。
    await rm(idx, { force: true })
    const out = await engine.recallForInjection(sessionId, '初次摄入', {
      turn: 1, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512,
    })
    assert.equal(out.status, 'skipped', '索引不存在时应如实回 skipped：' + out.status)
    assert.match(out.reason, /索引尚未就绪/, '必须与「无命中」区分：' + out.reason)
    // 热路径不得把索引重建出来
    const rebuilt = await stat(idx).then((s) => s.size, () => null)
    assert.equal(rebuilt, null, '热路径不得触发全量重建（实测 645ms，落在首字路径上）')
    const state = await engine.inspect(sessionId)
    assert.equal(state.injection.failed, 0, '索引未就绪不是错误，不得记成 failed')
  })
})

test('索引重建分寸：首次摄入必须建索引（否则新会话头几步回注结构性 skipped）', async () => {
  await withEngine(['第一回合的人类输入'], async ({ engine, sessionId }) => {
    const out = await engine.recallForInjection(sessionId, '第一回合的人类输入', {
      turn: 2, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512,
    })
    assert.equal(out.status, 'injected', '首次摄入后索引必须已就绪（首屏回注不得结构性失效）：' + (out.reason ?? out.error?.message ?? ''))
  })
})
