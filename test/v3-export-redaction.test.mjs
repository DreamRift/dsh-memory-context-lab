/**
 * 导出再脱敏守卫（AUD50-07-01，B2-10：导出包不重新脱敏，正文凭据原样进分享包）。
 *
 * ## 缺陷
 * buildExportBundle 直接 payload.text = record.payload.text；摄入只对 tool/result、
 * tool/call 脱敏，assistant/user 正文按产品口径带明文入库——导出是分享前的最后一道
 * 闸门，却把入库明文原样带进分享包（审计探针 beforeExport.jsonPlaintextInBundle=true）。
 *
 * ## 判据来源
 * docs/dev-0.14.0/审计-0.14.0-beta.50-后续-20261029.md §5 AUD50-07-01；任务书 B2-10。
 * 修法：buildExportBundle 对 payload.text 过 redactText、structure 过 redactValue
 * （与摄入共用 domain/security/redact.mjs，B1-1 同函数），根字段加 exportPolicy:
 * 'redacted'；导入按导入文本重建 bytes，roundtrip 不破坏。
 *
 * ## 断言组
 * - assistant / user / tool/result 三通道注入同一凭据：导出**文件字节**不含明文（B1-1 共用）；
 * - structure.toolCalls[].arguments 的凭据被替换（字符串与内嵌 JSON 两形态）；
 * - exportPolicy='redacted' 元数据在包根；
 * - 导入 roundtrip：新 ID/import 事务/sessionKey 契约成立、文本可读、目标隔离根字节不含明文。
 * - 遗忘/redacted 凭证剥离不回退（既有 v3-export 套件覆盖，本文件不断言）。
 *
 * ## 不适用条件与已知边界
 * - 摄入侧 user/assistant 正文仍不脱敏（beta.48 产品口径不变，改的是导出侧）；
 * - 遗忘记录本来就只导出 ID，不在本判据内。
 *
 * ## 定点变异自证
 * 临时绕过 bundle 的 redactText 调用 → 三通道与结构用例必红；恢复后全绿
 * （证据存 .tmp/fix-B2-10/）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const SECRET = 'hunter2secretX'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
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

test('B2-10 三通道：导出文件字节不含明文（user/assistant/tool/result）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-b10-export-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession()
    session.pushUser('用户通道 api_key="' + SECRET + '" 行')
    session.pushAssistant('助手通道 {"password": "' + SECRET + '"} 结束')
    session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: '工具输出 {"token": "' + SECRET + '"}' }] } })
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)

    const result = await engine.exportSession('session-fake')
    assert.equal(result.error, undefined, JSON.stringify(result))
    // 字节级断言：不是只查对象字段——分享包以文件字节为准。
    const bytes = await readFile(result.file)
    assert.ok(!bytes.includes(SECRET), '导出文件字节不得含明文')
    const parsed = JSON.parse(await readFile(result.file, 'utf8'))
    assert.equal(parsed.exportPolicy, 'redacted', '包根标注已脱敏')
    assert.equal(parsed.counts.records, 4, 'user/assistant/tool/result/当前问题 四条记录都在')
    const marked = parsed.records.filter((record) => record.payload.text.includes('[REDACTED]'))
    assert.equal(marked.length, 3, '三条带凭据的正文都有脱敏标记；无凭据的「当前问题」不误标')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B2-10 结构通道：toolCalls.arguments 的凭据被替换', () => {
  const bundle = buildExportBundle({
    sessionKey: 's',
    records: [
      {
        id: 'v3r-1',
        kind: 'message-assistant',
        createdAt: 1,
        payload: {
          text: '正文不涉及',
          bytes: 15,
          structure: {
            toolCalls: [
              { name: 'run', callId: 'c1', arguments: '{"api_key": "' + SECRET + '"}' },
              { name: 'post', callId: 'c2', arguments: { headers: '{"token": "' + SECRET + '"}' } },
            ],
          },
        },
        provenance: { sourceEventId: null, sourceForm: null, transactionId: null },
      },
    ],
  })
  const bytes = Buffer.from(JSON.stringify(bundle), 'utf8')
  assert.ok(!bytes.includes(SECRET), '导出包字节不得含明文（含结构）')
  assert.equal(bundle.records[0].payload.structure.toolCalls[0].arguments, '{"api_key": "[REDACTED]"}')
  assert.equal(bundle.records[0].payload.structure.toolCalls[1].arguments.headers, '{"token": "[REDACTED]"}')
  assert.equal(bundle.exportPolicy, 'redacted')
})

test('B2-10 导入 roundtrip：ID 保留、文本可读、目标根字节干净', async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'mcl-b10-a-'))
  const rootB = await mkdtemp(path.join(tmpdir(), 'mcl-b10-b-'))
  const ctxA = fakeCtx()
  const engineA = attachV3Engine(ctxA, { v3Root: rootA })
  const ctxB = fakeCtx()
  const engineB = attachV3Engine(ctxB, { v3Root: rootB })
  try {
    const sessionA = createFakeSession()
    sessionA.pushUser('用户通道 api_key="' + SECRET + '" 行')
    sessionA.pushAssistant('助手回复')
    sessionA.pushUser('当前问题')
    await ctxA.callPreStep(sessionA)
    await settle(engineA)
    const exported = await engineA.exportSession('session-fake')
    assert.equal(exported.error, undefined, JSON.stringify(exported))

    // 导入面读的是**本引擎 v3Root/exports/**：把 A 的导出文件放进 B 的导出目录。
    await mkdir(path.join(rootB, 'exports'), { recursive: true })
    const fileName = path.basename(exported.file)
    await copyFile(exported.file, path.join(rootB, 'exports', fileName))

    const sessionB = createFakeSession({ id: 'session-import' })
    const imported = await engineB.importSession('session-import', fileName, sessionB)
    assert.equal(imported.error, undefined, JSON.stringify(imported))

    // 导入契约（session-store.importRecords）：新 ID、新事务号、sessionKey 换成导入会话、
    // bytes 按导入文本重建；正文是脱敏产物且可读。字节级扫 B 的记录目录。
    const recordsDir = path.join(rootB, 'sessions', 'session-import', 'records')
    const files = (await readdir(recordsDir)).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 3, '导入后记录落盘：' + files.length)
    let sawImported = false
    for (const f of files) {
      const bytes = await readFile(path.join(recordsDir, f))
      assert.ok(!bytes.includes(SECRET), 'B 根记录字节不含明文：' + f)
      const record = JSON.parse(await readFile(path.join(recordsDir, f), 'utf8'))
      assert.equal(record.sessionKey, 'session-import', 'sessionKey 换成导入会话')
      assert.equal(record.provenance.sourceForm, 'import', '来源标记 import')
      assert.ok(/^v3r-[0-9a-f]{16}$/.test(record.id), '新记录 ID 形状：' + record.id)
      assert.match(record.provenance.transactionId, /^import-/, '新事务号')
      if (record.payload.text.includes('用户通道')) {
        sawImported = true
        assert.ok(record.payload.text.includes('[REDACTED]'), '导入文本是脱敏产物：' + record.payload.text)
        assert.equal(record.payload.bytes, Buffer.byteLength(record.payload.text, 'utf8'), 'bytes 与导入文本一致')
      }
    }
    assert.ok(sawImported, '导入记录可读（含用户通道那条）')
  } finally {
    await engineA._waitForIdle().catch(() => {})
    engineA.dispose()
    await engineB._waitForIdle().catch(() => {})
    engineB.dispose()
    await rm(rootA, { recursive: true, force: true }).catch(() => {})
    await rm(rootB, { recursive: true, force: true }).catch(() => {})
  }
})
