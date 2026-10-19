/**
 * 0.13.1 守卫：存储层的六处「能写进去、读不回来」缺陷。
 *
 * 全部由独立复审 + 临时目录探针实测发现，每条都先写成**必红**的用例再修。
 *
 * 1. stageRecord 带 content 但没声明 payload → 解引用 undefined 抛 TypeError
 *    （不是 EngineV2Error），事务号与 WAL 意图文件一起残留。
 * 2. 只校验 payload.hash、不校验 payload.size → 按字符数算 size 的记录能提交成功，
 *    之后每次读都判 size-mismatch、payloadText=null，记录永久不可读却仍在 catalog。
 * 3. 同一 handle 并发 stageRecord → 两条记录拿到同一个稳定 ID，后写覆盖先写。
 * 4. open() 对账完成前就登记进 openDirectories → peekOpen 能拿到 manifest 还没赋值的
 *    半成品句柄（fork 会把它当空闭包迁移，子库 0 条、静默丢历史）。
 * 5. readRecord 的 offsetBytes 在「全文不大于 maxBytes」时被静默忽略 → 分块读重复内容。
 * 6. openTransaction 的 WAL 写失败时事务号残留 → hasOpenTransactions 恒 true，
 *    同号在进程内永远打不开。
 *
 * ## 不适用条件
 * 全部用临时隔离目录，不触碰真实 $DSH_HOME。第 4 条是时序不变量，靠「open 期间
 * 反复 peek」采样，采样不到窗口也算通过（它验证的是「不会暴露坏句柄」，不是
 * 「一定会暴露」）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore, EngineV2Error } from '../src/v2/store.mjs'
import { recordId } from '../src/v2/records.mjs'
import { sessionKeyFor } from '../src/storage.mjs'

const tmpRoots = []
async function newLabRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-store-hard-'))
  tmpRoots.push(root)
  return root
}
async function cleanup() {
  while (tmpRoots.length) await rm(tmpRoots.pop(), { recursive: true, force: true })
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/** 一条最小可提交的记录草案（非 verbatim，默认不带载荷）。 */
function textDraft(seq, content = null) {
  const draft = {
    kind: 'assistant.text',
    seq,
    fidelity: 'lossy',
    refs: { messageId: 'm_' + seq, turn: 1 },
    inline: { note: 'x' },
    createdAt: '2026-10-19T00:00:00.000Z',
  }
  if (content !== null) draft.content = content
  return draft
}

/** 一条带正确载荷声明的记录草案。 */
function verbatimDraft(seq, text) {
  const buffer = Buffer.from(text, 'utf8')
  return {
    kind: 'operation.result',
    seq,
    fidelity: 'verbatim',
    refs: { callId: 'c_' + seq, resultMessageId: 'rm_' + seq },
    inline: {},
    createdAt: '2026-10-19T00:00:00.000Z',
    content: text,
    payload: {
      hash: 'sha256:' + createHash('sha256').update(buffer).digest('hex'),
      size: buffer.byteLength,
      encoding: 'utf8',
    },
  }
}

test('带正文但没声明载荷：结构化报错，事务不被烧号', async () => {
  const labRoot = await newLabRoot()
  const store = await V2SessionStore.init({ labRoot, sessionId: 'a'.repeat(24) })
  try {
    const txn = await store.openTransaction()
    let thrown = null
    try {
      await store.stageRecord(txn, textDraft(1, 'hello'))
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, '带正文却不声明载荷必须报错，不能写进不可读的记录')
    assert.ok(thrown instanceof EngineV2Error, '必须是 EngineV2Error（调用方按 code 分支），实际 ' + thrown?.constructor?.name)
    assert.equal(thrown.code, 'ESCHEMA')
    const ok = await store.stageRecord(txn, textDraft(1))
    assert.equal(ok.id, recordId(txn.txn, 0))
    const committed = await store.commitTransaction(txn)
    assert.equal(committed.recordCount, 1)
  } finally {
    await store.close()
    await cleanup()
  }
})

test('载荷 size 与正文实际字节数不符：阶段化即拒绝', async () => {
  const labRoot = await newLabRoot()
  const store = await V2SessionStore.init({ labRoot, sessionId: 'b'.repeat(24) })
  try {
    const txn = await store.openTransaction()
    const draft = verbatimDraft(1, '中文正文测试内容')
    // 最自然的误用：按字符数算 size（8 字符 / 24 字节），hash 仍按真实字节算对。
    draft.payload.size = '中文正文测试内容'.length
    let thrown = null
    try {
      await store.stageRecord(txn, draft)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof EngineV2Error, 'size 与正文不一致必须拒绝，实际 ' + thrown?.constructor?.name)
    assert.equal(thrown.code, 'ESCHEMA')
    assert.match(thrown.message, /载荷大小/)
  } finally {
    await store.close()
    await cleanup()
  }
})

test('同一 handle 并发阶段化：稳定 ID 不得重复', async () => {
  const labRoot = await newLabRoot()
  const store = await V2SessionStore.init({ labRoot, sessionId: 'c'.repeat(24) })
  try {
    const txn = await store.openTransaction()
    // 用**带载荷**的草案：载荷落盘是 await 点，两个调用会在那里交错。
    const [a, b] = await Promise.all([
      store.stageRecord(txn, verbatimDraft(1, 'first payload')),
      store.stageRecord(txn, verbatimDraft(2, 'second payload')),
    ])
    assert.notEqual(a.id, b.id, '并发阶段化拿到了同一个稳定 ID：' + a.id)
    const committed = await store.commitTransaction(txn)
    assert.equal(committed.recordCount, 2)
    assert.equal(store.recordCount, 2, 'catalog 必须真的存下两条')
    const first = await store.readRecord(a.id)
    assert.equal(first.ok, true)
    assert.equal(first.record.seq, 1, 'ID 必须仍指向自己那条记录')
    assert.equal(first.payloadText, 'first payload')
    const second = await store.readRecord(b.id)
    assert.equal(second.record.seq, 2)
    assert.equal(second.payloadText, 'second payload')
  } finally {
    await store.close()
    await cleanup()
  }
})

test('对账期间的 peekOpen 不得暴露半成品句柄', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'd'.repeat(24)
  const seed = await V2SessionStore.init({ labRoot, sessionId })
  for (let i = 1; i <= 3; i += 1) {
    const txn = await seed.openTransaction()
    await seed.stageRecord(txn, textDraft(i))
    await seed.commitTransaction(txn)
  }
  const expected = seed.recordCount
  await seed.close()

  const opening = V2SessionStore.open({ labRoot, sessionId })
  let done = false
  const problems = []
  const probe = (async () => {
    while (!done) {
      const peeked = V2SessionStore.peekOpen(labRoot, sessionId)
      if (peeked) {
        try {
          const warnings = peeked.warnings
          const count = peeked.recordCount
          if (!Array.isArray(warnings)) problems.push('warnings 不是数组')
          if (count !== expected) problems.push('半成品句柄暴露了错误的 recordCount：' + count + ' != ' + expected)
        } catch (error) {
          problems.push('peekOpen 暴露了未对账的句柄：' + error.message)
        }
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  })()
  const store = await opening
  done = true
  await probe
  assert.deepEqual([...new Set(problems)], [], [...new Set(problems)].join('；'))
  assert.equal(store.recordCount, expected)
  await store.close()
  await cleanup()
})

test('offsetBytes 在全文不大于 maxBytes 时同样生效', async () => {
  const labRoot = await newLabRoot()
  const store = await V2SessionStore.init({ labRoot, sessionId: 'e'.repeat(24) })
  try {
    const txn = await store.openTransaction()
    const text = 'A'.repeat(40) + 'B'.repeat(40)
    const staged = await store.stageRecord(txn, verbatimDraft(1, text))
    await store.commitTransaction(txn)
    const fromZero = await store.readRecord(staged.id, { maxBytes: 1000 })
    assert.equal(fromZero.payloadText, text)
    const middle = await store.readRecord(staged.id, { maxBytes: 1000, offsetBytes: 40 })
    assert.equal(middle.payloadText, 'B'.repeat(40),
      'offsetBytes 被忽略了：拿到了 ' + JSON.stringify(middle.payloadText?.slice(0, 10)))
    assert.equal(middle.truncated, false)
    const beyond = await store.readRecord(staged.id, { maxBytes: 1000, offsetBytes: 500 })
    assert.equal(beyond.payloadText, '')
  } finally {
    await store.close()
    await cleanup()
  }
})

test('事务意图写盘失败：事务号不残留，重试可用', async () => {
  const labRoot = await newLabRoot()
  const sessionId = 'f'.repeat(24)
  const store = await V2SessionStore.init({ labRoot, sessionId })
  const directory = path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(sessionId))
  const transactions = path.join(directory, 'transactions')
  try {
    // 把 transactions 换成同名文件：下一次写意图文件必然失败。
    await rm(transactions, { recursive: true, force: true })
    await writeFile(transactions, 'blocked', 'utf8')
    let thrown = null
    try {
      await store.openTransaction()
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, '目录被占时必须报错')
    assert.equal(store.hasOpenTransactions, false,
      '失败的事务号必须撤销登记，否则本进程内 hasOpenTransactions 恒 true')
    await rm(transactions, { force: true })
    await mkdir(transactions, { recursive: true })
    const txn = await store.openTransaction()
    await store.stageRecord(txn, textDraft(1))
    const committed = await store.commitTransaction(txn)
    assert.equal(committed.recordCount, 1)
  } finally {
    await store.close()
    await cleanup()
  }
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name + '\n     ' + (error?.message ?? error))
  }
}
await cleanup()
if (failed > 0) {
  console.log('\n' + failed + '/' + tests.length + ' 条用例失败')
  process.exitCode = 1
} else {
  console.log('\n' + tests.length + ' 条用例通过')
}
