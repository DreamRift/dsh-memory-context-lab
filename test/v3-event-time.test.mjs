/**
 * B3-1 事件时间（AUD50-02-06）——归一化只在合法时保留事件时间，非法/缺失如实缺失；
 * provenance.eventAt 可追溯事件时间；createdAt 语义 = 摄入时间，不被事件时间覆盖。
 *
 * ## 断言组
 * - 归一化三态：time 合法 → at=该值；非法 → 无 at + atReason:'invalid'；缺失 → 无 at + atReason:'missing'；
 * - 合同校验：at 缺失合法、at 非法拒绝；
 * - processTurn：eventAt 进 provenance 且随记录落盘；createdAt 保持摄入时刻，不被事件时间覆盖；
 * - composition：非法/缺失事件时间计数可见，正常事件不计数。
 *
 * ## 不适用条件与已知边界
 * 旧记录无 eventAt 不报错（validateRecord 不要求该字段）；回填走 processTurn.many 同路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { normalizeDshEvent } from '../src/v3/adapters/host/dsh-host.mjs'
import { validateEvent, validateRecord } from '../src/v3/contracts/index.mjs'
import { createProcessTurn } from '../src/v3/application/process-turn.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'

const OWN = ['dsh-memory-context-lab']
const EVENT_TIME = 1792845000123
const INGEST_TIME = 1799999999999

function fakeClock() {
  let t = INGEST_TIME
  return { now: () => t }
}

function fakeRandom() {
  let n = 0
  return { uuid: () => String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000' }
}

function fakeMetrics() {
  const counters = new Map()
  return { counters, counter(name, value) { counters.set(name, (counters.get(name) ?? 0) + value) }, observe() {} }
}

async function withDeps(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-eventtime-'))
  const { port, store } = await createSessionStorePort(root, 'sess-a')
  try {
    const processTurn = createProcessTurn({ store: port, clock: fakeClock(), random: fakeRandom(), ownSourceKinds: OWN })
    return await body({ processTurn, port })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function userEvent(at) {
  return { id: 'evt-1', type: 'user', sessionKey: 'sess-a', ...(at !== undefined ? { at } : {}), source: { kind: 'user', form: null } }
}

test('归一化三态：合法保留 / 非法丢弃记 invalid / 缺失记 missing', () => {
  const legal = normalizeDshEvent({ seq: 1, type: 'user/message', time: EVENT_TIME, data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(legal.ok, true)
  assert.equal(legal.event.at, EVENT_TIME, '合法宿主时间必须保留')
  assert.equal(legal.atReason, undefined)

  const invalid = normalizeDshEvent({ seq: 2, type: 'user/message', time: 'not-a-number', data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(invalid.ok, true, '时间非法不拒事件（正文照常入库）')
  assert.equal(invalid.event.at, undefined, '非法时间丢弃，不伪造 0')
  assert.equal(invalid.atReason, 'invalid')
  const negative = normalizeDshEvent({ seq: 3, type: 'user/message', at: -5, data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(negative.event.at, undefined, '负数时间也是非法')
  assert.equal(negative.atReason, 'invalid')

  const missing = normalizeDshEvent({ seq: 4, type: 'user/message', data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(missing.event.at, undefined, '缺失如实缺失')
  assert.equal(missing.atReason, 'missing')
})

test('合同校验：at 缺失合法；at 非法拒绝', () => {
  assert.equal(validateEvent(userEvent(undefined)).ok, true, 'at 缺失合法（B3-1）')
  assert.equal(validateEvent(userEvent(EVENT_TIME)).ok, true)
  const bad = validateEvent(userEvent('not-a-number'))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => /at/.test(e)))
})

test('processTurn：eventAt 进 provenance；createdAt 保持摄入时间不被覆盖', async () => {
  await withDeps(async ({ processTurn, port }) => {
    const withTime = await processTurn({ event: userEvent(EVENT_TIME), text: '带时间正文' })
    assert.equal(withTime.status, 'applied')
    const storedWith = await port.readRecord(withTime.recordId)
    assert.equal(storedWith.provenance.eventAt, EVENT_TIME, '事件时间进 provenance')
    assert.equal(storedWith.createdAt, INGEST_TIME, 'createdAt = 摄入时间')
    assert.notEqual(storedWith.createdAt, EVENT_TIME, 'createdAt 不被事件时间覆盖')
    assert.equal(validateRecord(storedWith).ok, true, '含 eventAt 的记录仍过结构校验')

    const noTime = await processTurn({ event: userEvent(undefined), text: '无时间正文' })
    const storedNo = await port.readRecord(noTime.recordId)
    assert.equal(storedNo.provenance.eventAt, undefined, '缺失事件时间如实缺失，不伪造')
    assert.equal(validateRecord(storedNo).ok, true, '旧口径（无 eventAt）记录不报错')
  })
})

function fakeDshSession() {
  let seq = 0
  const events = new Map()
  const surfaceNodes = new Set()
  const session = {
    id: 'dsh-session-eventtime',
    surface: { nodes: [] },
    append(type, data, options) {
      seq += 1
      events.set(seq, { seq, type, data, options })
      surfaceNodes.add(seq)
      session.surface.nodes = [...surfaceNodes]
      return { seq }
    },
    eventAt(s) { return events.get(s) },
    deriveMessages() { return [] },
    events: [],
  }
  return session
}

test('composition：非法/缺失事件时间计数可见；正常事件不计数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-eventtime-comp-'))
  const dshSession = fakeDshSession()
  try {
    const runtime = await createV3Runtime({ v3Root: root, dshSession })
    try {
      const good = await runtime.handleDshEvent({ seq: 1, type: 'user/message', time: EVENT_TIME, data: { message: { content: [{ type: 'text', text: '正常时间' }] }, source: { kind: 'user' } } })
      assert.equal(good.status, 'applied')
      const missing = await runtime.handleDshEvent({ seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: '缺时间' }] }, source: { kind: 'user' } } })
      assert.equal(missing.status, 'applied', '缺时间事件照常入库')
      const invalid = await runtime.handleDshEvent({ seq: 3, type: 'assistant/message', time: NaN, data: { message: { content: [{ type: 'text', text: '坏时间' }] } } })
      assert.equal(invalid.status, 'applied', '非法时间事件照常入库')
      const snap = runtime.metrics()
      assert.equal(snap.counters['v3.ingest.eventAtMissing'], 1)
      assert.equal(snap.counters['v3.ingest.eventAtInvalid'], 1)
    } finally {
      runtime.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
