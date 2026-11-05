/**
 * P3-07（0.15.1 独立排查报告 §3.3）：`checkpoint`/`usage` 追加路径**不得**整本解析台账。
 *
 * ## 缺陷
 * `appendCheckpoint` 在追加前调用 `parseTxnLog` 解析**整本** `checkpoint.jsonl`，只为判断
 * 「现在能不能再写一行」。检查点是一笔事务一行，长会话累积到 2 万行时每次提交都要
 * 读 + 解析 1.4 MB。实测（win32-x64，Node v26.12.1）：
 * - 修前：20000 行账本 **12.08 ms/次**，1 行账本 0.58 ms/次（≈ 与行数成正比）；
 * - 修后：20000 行账本 **1.10 ms/次**（尾部窗口 64 KiB，与账本长度无关）。
 *
 * ## 判据来源与修法
 * 追加只接触文件**尾部**；「尾部是否可安全追加」与「整本是否每行可解析」是两个问题。
 * 因此把追加门收敛到 `adapters/storage/append-tail.mjs` 的 `inspectAppendTail`（有界窗口），
 * **读门不变**：`readCheckpoint` 仍整本解析、首个坏行即 `usable:false` 并回退全量扫描。
 * 判据没有放宽——中段损坏仍然失败关闭，只是**追加不再为读面的判据付钱**。
 *
 * ## 断言组
 * 1. **成本**：20000 行账本上连续追加的平均耗时 < 4 ms/次（修前 12.1 ms）；
 * 2. **尾部半行**（append 中途崩溃）→ 拒绝追加，理由指向 repair；
 * 3. **干净尾部** / **合法 JSON 缺收尾换行** → 允许追加（后者是已写完整的最后一行）；
 * 4. **窗口内中段坏行** → 拒绝追加；
 * 5. **窗口之外的中段坏行** → 追加门放行（有界判据的已知边界），但 `readCheckpoint`
 *    仍然 `usable:false`——读面的失败关闭没有被这次修法带来放宽；
 * 6. 追加门不改变读面判定：同一份错乱账本，修法前后 `readCheckpoint` 的结论一致（第 4/5 组）。
 *
 * ## 不适用条件与已知边界
 * - 本套件不证明 `usage.jsonl` 的追加成本已消除：它的性能项是**另一件事**（见文件末尾说明），
 *   实测 `appendUsageLine` 的耗时主要由会话跨进程写锁与锁内 stat 决定，与行数无关
 *   （1000 行 9.05 ms / 5000 行 8.92 ms / 20000 行 8.84 ms），因此本项按「已测量、非台账长度
 *   驱动」如实登记，不假装做了优化。
 * - 成本阈值的绝对值依赖机器；断言取的是「与账本长度无关」的数量级（< 4 ms，
 *   修前 12 ms），不是精确基准。CI 上偏慢的机器仍应通过（窗口读取是一次 64 KiB read）。
 *
 * ## 定点变异自证（改回去必红）
 * 把 `appendCheckpoint` 的判据换回 `parseTxnLog` 整本解析 → 第 1 组红（实测 12.1 ms/次）。
 * 读数见台账 R21。
 *
 * ## 运行
 * `node --test test/v3-append-tail-cost.test.mjs`（全量：`node scripts/test-all.mjs`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { inspectAppendTail, APPEND_TAIL_BYTES } from '../src/v3/adapters/storage/append-tail.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const ROWS = 20000
const APPEND_BUDGET_MS = 4

const checkpointRow = (txn, i) => JSON.stringify({ action: 'checkpoint', txn, pairs: [['evt-' + i, 'v3r-' + i]] })

async function withStore(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p307-'))
  try {
    const store = await openV3SessionStore(root, 'p307')
    try {
      return await body(store, path.join(store.directory, 'checkpoint.jsonl'))
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P3-07 ①成本：20000 行账本上的追加不再随台账长度线性增长', async () => {
  await withStore(async (store, file) => {
    const rows = []
    for (let i = 1; i <= ROWS; i += 1) rows.push(checkpointRow(1000000 + i, i))
    await writeFile(file, rows.join('\n') + '\n', 'utf8')

    // 预热一次（首次 read 会把文件读进页缓存；这一项衡量的是解析成本，不是冷盘成本）
    await store.appendCheckpoint(3000000, [])

    const started = process.hrtime.bigint()
    const COUNT = 30
    for (let i = 1; i <= COUNT; i += 1) {
      const result = await store.appendCheckpoint(3000000 + i, [['evt-x' + i, 'v3r-x' + i]])
      assert.equal(result.appended, true, '干净尾部必须允许追加')
    }
    const perAppend = Number(process.hrtime.bigint() - started) / 1e6 / COUNT
    assert.ok(perAppend < APPEND_BUDGET_MS,
      '追加成本必须与台账行数解耦（' + ROWS + ' 行实测 ' + perAppend.toFixed(2)
      + ' ms/次，预算 ' + APPEND_BUDGET_MS + ' ms；整本解析的旧实现为 ~12 ms/次）')
  })
})

test('P3-07 ②尾部半行（append 中途崩溃）→ 拒绝追加，理由指向 repair', async () => {
  await withStore(async (store, file) => {
    await writeFile(file, checkpointRow(1, 1) + '\n' + '{"action":"checkpoint","tx', 'utf8')
    const result = await store.appendCheckpoint(2, [])
    assert.equal(result.appended, false, '半行尾部不得追加（新行会与坏行一起不可解析）')
    assert.match(result.reason, /尾部半行/, '理由必须说清是尾部半行')
    assert.match(result.reason, /repair/, '必须给出可执行的下一步')
  })
})

test('P3-07 ③干净尾部允许追加；「缺收尾换行但可解析」的完整行也必须先补换行再追加', async () => {
  await withStore(async (store, file) => {
    await writeFile(file, checkpointRow(1, 1) + '\n', 'utf8')
    assert.equal((await store.appendCheckpoint(2, [])).appended, true, '干净尾部')

    // 合法 JSON、只是缺结尾换行（编辑器/中断之外的常见形态）：那一行本身没坏，所以
    // 追加门放行；但**必须先把换行补上**，否则新行会粘在它后面，两行一起不可解析。
    // R23（QC 复核）：旧实现放行且不补换行 —— 追加返回 appended:true，而读面立刻
    // 多出「第 1 行不可解析」，等于用一次成功的追加把整个检查点账本打成不可读。
    await writeFile(file, checkpointRow(1, 1), 'utf8')
    const repaired = await store.appendCheckpoint(3, [])
    assert.equal(repaired.appended, true, '缺换行的完整行：允许追加')
    assert.equal(repaired.newlineRepaired, true, '必须如实回报补过换行')

    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 2, '必须是两行（粘行 = 数据损坏）：实际 ' + JSON.stringify(text.slice(-60)))
    for (const [index, line] of lines.entries()) {
      assert.doesNotThrow(() => JSON.parse(line), '第 ' + (index + 1) + ' 行必须仍可解析')
    }
    // 读面的结论也不能因为这次追加而变坏：两次追加的两行都读得到。
    const read = await store.readCheckpoint()
    assert.equal(String(read.reason ?? '').includes('不可解析'), false, '追加不得让读面出现不可解析行：' + String(read.reason))
  })
})

test('P3-07 ④窗口内中段坏行 → 拒绝追加；读面同样失败关闭', async () => {
  await withStore(async (store, file) => {
    await writeFile(file, 'NOT-JSON\n' + checkpointRow(1, 1) + '\n', 'utf8')
    const result = await store.appendCheckpoint(2, [])
    assert.equal(result.appended, false, '窗口内的坏行必须挡住追加')
    assert.match(result.reason, /不可解析/)
    const read = await store.readCheckpoint()
    assert.equal(read.usable, false, '读面同样失败关闭')
  })
})

test('P3-07 ⑤窗口外的中段坏行：追加门放行（已知边界），但读面仍失败关闭', async () => {
  await withStore(async (store, file) => {
    // 坏行在最前，后面塞满完整行把它挤到 64 KiB 窗口之外
    const pad = []
    for (let i = 1; i <= 4000; i += 1) pad.push(checkpointRow(i, i))
    const text = 'BROKEN-FIRST-LINE\n' + pad.join('\n') + '\n'
    await writeFile(file, text, 'utf8')
    assert.ok(Buffer.byteLength(text, 'utf8') > APPEND_TAIL_BYTES * 2, '夹具必须让坏行落在窗口之外')

    const tail = await inspectAppendTail(file)
    assert.equal(tail.appendable, true, '有界判据只看尾部：窗口外损坏不在追加门的判定范围')
    assert.equal((await store.appendCheckpoint(999999, [])).appended, true, '追加门放行')

    // 但「读面」的判据没有放宽：整本解析仍会撞上那行坏行。
    const read = await store.readCheckpoint()
    assert.equal(read.usable, false, '读面必须仍失败关闭（否则这次修法就真的放宽了判据）')
    assert.match(String(read.reason), /不可解析/)
  })
})
