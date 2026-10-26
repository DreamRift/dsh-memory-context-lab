/**
 * v3 会话隔离键的路径安全守卫（H-08，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * sessionIsolationKey 只做 trim + NFC，随后 sessionKey 被直接拼成
 * `<v3Root>/sessions/<sessionKey>`（session-store.mjs 的 sessionDirOf）。
 * 于是：
 * - `'../../escape'` 把记录写到数据根**之外**（实测落到 %TEMP%/escape）；
 * - `'..'` 把 records/ transactions.jsonl 直接写进数据根；
 * - `'a/b'`、`'a\\b'` 造出多级目录，与别的会话目录混层。
 * 隔离键是「跨会话不串数据的第一道闸」，却允许越界写出——这道闸形同虚设。
 *
 * ## 判据
 * - 含路径分隔符 / 控制字符 / 冒号（盘符与 NTFS ADS）/ 点段 / 尾点尾空格 / Windows
 *   保留设备名 / 超长的键一律 `ESESSION_INVALID_ID` 失败关闭，不得落到磁盘；
 * - 合法键（含中文、空格、连字符）行为不变；
 * - 越界写出必须为零：数据根之外不得出现新目录。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 v3 数据根下的会话目录命名；v2 的 `sha256 前 24 位` 目录口径不在本判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { sessionIsolationKey } from '../src/v3/domain/session/isolation-key.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function sessionOf(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: events.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
    push(type, data) {
      const seq = events.length
      events.push({ seq, type, at: seq, data: data ?? {} })
    },
  }
}

const UNSAFE_KEYS = [
  ['父级穿越', '../../escape'],
  ['点段', '..'],
  ['单点', '.'],
  ['正斜杠', 'a/b'],
  ['反斜杠', 'a\\b'],
  ['盘符/ADS 冒号', 'C:evil'],
  ['NUL 字节', 'a\u0000b'],
  ['换行控制字符', 'a\nb'],
  ['尾点', 'abc.'],
  ['Windows 保留名', 'CON'],
  ['Windows 保留名小写', 'nul'],
  ['超长', 'x'.repeat(400)],
]

test('H-08 隔离键拒绝路径穿越与危险形态（失败关闭，不落到磁盘）', () => {
  for (const [label, key] of UNSAFE_KEYS) {
    assert.throws(
      () => sessionIsolationKey(key),
      (error) => error?.code === 'ESESSION_INVALID_ID',
      label + ' 必须失败关闭：' + JSON.stringify(key).slice(0, 40),
    )
  }
})

test('H-08 合法键行为不变（中文/空格/连字符/下划线）', () => {
  assert.equal(sessionIsolationKey('  session-abc  '), 'session-abc', 'trim 保留')
  assert.equal(sessionIsolationKey('会话-中文-1'), '会话-中文-1')
  assert.equal(sessionIsolationKey('session with space'), 'session with space')
  assert.equal(sessionIsolationKey('a_b-c.d'), 'a_b-c.d', '中间的点合法')
  assert.equal(sessionIsolationKey('session-84a5729a-c15e-44b1-92da-c24e075d5607-old-1792906652468').length > 0, true)
})

test('H-08 端到端：越界键不产生任何数据根之外的目录', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mcl-h08-parent-'))
  const root = path.join(parent, 'v3root')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root, { recursive: true })
  try {
    const before = new Set(await readdir(parent))
    for (const [, key] of UNSAFE_KEYS) {
      const session = sessionOf(key)
      session.push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '正文' }] })
      // 2026-10-26 清单处置：危险键不再拒绝装配，改哈希目录名（isolation 纯函数仍失败关闭，
      // composition 层 catch 后哈希）。端到端不变量不变：数据不出根。
      const rt = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: key })
      assert.ok(rt.sessionKey.startsWith('hash-'), '危险键走哈希目录：' + JSON.stringify(key).slice(0, 40))
      await rt.dispose?.()
    }
    const after = await readdir(parent)
    assert.deepEqual(after.filter((name) => !before.has(name)), [], '数据根之外不得出现新条目')
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {})
  }
})
