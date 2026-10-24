/**
 * 0.13.2-beta.6 守卫（二）：G1 账本协议单一实现 + G4 状态字段单一真源。
 *
 * G1 的判据是**协议行为**，不是「谁调用了哪个函数」：
 *   1. 0 字节账本必须补 header（不是「文件存在就一定有 header」）；
 *   2. 末尾缺 LF 时追加必须补 LF（否则两条 JSON 拼成一行，整本 damaged）；
 *   3. 尾部半行只在**解析失败**时截断——末尾缺 LF 的**完整合法条目**不得被删；
 *   4. 并发首写不得写出两行 header。
 *
 * 这四条此前在三份账本里各错一处（disposition 缺 1、hierarchy 缺 1、provenance 缺 3/4）。
 * 现在只有一份实现，所以守卫直接打这份实现——**任何一份账本再自己写一遍 I/O，
 * 就会绕开这里，而下方「三份账本都走同一实现」的静态断言会红**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createAppendableLedger } from '../src/v2/appendable-ledger.mjs'
import { REQUIRED_STATE_FIELDS, isV2SessionState, stateWithDefaults } from '../src/v2/state.mjs'
import { readFile as readSrc } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const HEADER = { kind: 'test/ledger', schemaVersion: 1 }

/** 最小可用的账本形状：首行 header，其余每行一条 {id}。 */
function parseLedger(text) {
  const lines = text.split('\n')
  // 末尾「缺 LF 但本身是完整 JSON」不是半行——与生产实现同口径：先试解析再判半行。
  let partialLine = ''
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    try {
      JSON.parse(lines[lines.length - 1])
    } catch {
      partialLine = lines[lines.length - 1]
    }
  }
  const complete = partialLine ? lines.slice(0, -1) : lines
  if (complete.length === 0) return { header: null, entries: [], damaged: false, partialLine }
  let header = null
  const entries = []
  for (const [index, line] of complete.entries()) {
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return { header, entries, damaged: true, damageDetail: `line ${index + 1} not json`, partialLine: '' }
    }
    if (index === 0) header = value
    else entries.push(value)
  }
  return { header, entries, damaged: false, partialLine }
}

async function freshLedger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'beta6-ledger-'))
  const file = path.join(dir, 'test.jsonl')
  const ledger = createAppendableLedger({ file, sessionDir: dir, header: HEADER, parse: parseLedger })
  return { dir, file, ledger }
}

test('G1：0 字节账本追加时必须补 header（不是「有文件就有 header」）', async () => {
  const { dir, file, ledger } = await freshLedger()
  try {
    await writeFile(file, '', 'utf8')
    await ledger.appendLines([{ id: 'a' }])
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    assert.equal(lines.length, 2, '必须是 header + 1 条')
    assert.deepEqual(JSON.parse(lines[0]), HEADER)
    assert.deepEqual(JSON.parse(lines[1]), { id: 'a' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G1：空白账本（只有空白、没有任何有效内容）追加时同样必须补 header（trim 判据的定向还原点）', async () => {
  const { dir, file, ledger } = await freshLedger()
  try {
    // beta.8 revert-probe：G1 场景的还原点把判据从 `text.trim().length === 0`
    // 退回 `text.length === 0`——只有 0 字节用例时还原点不红（两判据对 0 字节同判）。
    // 空白文件正是两判据唯一分歧的输入：length=2 但 trim 后为空，必须按空账本补 header。
    await writeFile(file, ' \n', 'utf8')
    await ledger.appendLines([{ id: 'a' }])
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    assert.notEqual((lines[0] ?? '').trim(), '', '首行不得是空白行：空白账本必须先补 header 再追加')
    assert.deepEqual(JSON.parse(lines[0]), HEADER)
    assert.deepEqual(JSON.parse(lines[1]), { id: 'a' })
    const loaded = await ledger.load()
    assert.equal(loaded.damaged, false, '补 header 后不得判 damaged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G1：末尾缺 LF 时追加必须补 LF（否则两条 JSON 拼成一行）', async () => {
  const { dir, file, ledger } = await freshLedger()
  try {
    // 手工造一个「header + 一条，但末尾没有 LF」的账本（外部编辑器/旧版本会留下这种）
    await writeFile(file, JSON.stringify(HEADER) + '\n' + JSON.stringify({ id: 'a' }), 'utf8')
    await ledger.appendLines([{ id: 'b' }])
    const text = await readFile(file, 'utf8')
    const lines = text.trimEnd().split('\n')
    assert.equal(lines.length, 3, '每条必须独占一行')
    assert.deepEqual(JSON.parse(lines[2]), { id: 'b' })
    const loaded = await ledger.load()
    assert.equal(loaded.damaged, false, '补 LF 后不得判 damaged')
    assert.equal(loaded.entries.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G1：末尾缺 LF 的**完整合法条目**不得被当成半行删掉（读一次不能删一条）', async () => {
  const { dir, file, ledger } = await freshLedger()
  try {
    await writeFile(file, JSON.stringify(HEADER) + '\n' + JSON.stringify({ id: 'keep-me' }), 'utf8')
    const loaded = await ledger.load()
    assert.equal(loaded.repairedBytes, 0, '完整条目不是半行，不许截断')
    assert.deepEqual(loaded.entries, [{ id: 'keep-me' }])
    const onDisk = await readFile(file, 'utf8')
    assert.match(onDisk, /keep-me/, '读路径不得物理删除完整条目')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G1：并发首写不得写出两行 header', async () => {
  const { dir, file, ledger } = await freshLedger()
  try {
    await Promise.all([ledger.appendLines([{ id: 'a' }]), ledger.appendLines([{ id: 'b' }])])
    const text = await readFile(file, 'utf8')
    const headerCount = text.split('\n').filter((line) => line.includes('test/ledger')).length
    assert.equal(headerCount, 1, 'header 只能有一行')
    const loaded = await ledger.load()
    assert.equal(loaded.damaged, false)
    assert.equal(loaded.entries.length, 2, '两笔追加都不能丢')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G1：三份账本都经由同一实现（静态：不得各自再写一套 header/尾部修复 I/O）', async () => {
  const files = ['v2/disposition.mjs', 'v2/hierarchy-store.mjs', 'v2/provenance-index.mjs']
  for (const rel of files) {
    const text = await readSrc(path.join(SRC, rel), 'utf8')
    assert.match(text, /createAppendableLedger/, `${rel} 必须使用共用账本实现`)
    assert.doesNotMatch(
      text,
      /appendFile\(\s*[a-zA-Z]/,
      `${rel} 不得自己 appendFile（那正是三份实现漂移的起点）`,
    )
  }
})

// ------------------------------------------------------------------ G4

test('G4：状态字段清单只有一份，闸门与消费者读同一份', () => {
  const complete = {
    kind: 'dsh-memory-context-lab/v2/session',
    schemaVersion: 2,
    sessionId: 's',
    createdAt: 'now',
    settings: {},
    archive: [],
    enabled: true,
  }
  assert.equal(isV2SessionState(complete), true)

  // 每个必需字段单独缺失时，闸门与消费者必须**给出同一个答案**：
  // 缺字段是版本差（旧账本），补默认值即可；字段在但值非法才是损坏。
  // 守卫锁的是「两份清单不得分叉」，不是「缺字段必须拒绝」——后者会把旧账本判死。
  for (const field of REQUIRED_STATE_FIELDS) {
    const missing = { ...complete }
    delete missing[field.name]
    assert.equal(isV2SessionState(missing), true, `缺 ${field.name} 属于版本差，不得判损坏`)
    assert.equal(field.name in stateWithDefaults(missing), true, `消费者必须能补出 ${field.name}`)

    const invalid = { ...complete, [field.name]: field.name === 'archive' ? 'not-an-array' : 42 }
    assert.equal(isV2SessionState(invalid), false, `${field.name} 类型非法必须判损坏`)
  }
})

test('G4：stateWithDefaults 补齐的正是闸门要求的那些字段（清单不得再分叉）', () => {
  const minimal = { kind: 'dsh-memory-context-lab/v2/session', schemaVersion: 2, sessionId: 's', enabled: true }
  const filled = stateWithDefaults(minimal)
  for (const field of REQUIRED_STATE_FIELDS) {
    assert.ok(field.name in filled, `stateWithDefaults 必须补 ${field.name}`)
  }
  assert.equal(isV2SessionState(filled), true)
})
