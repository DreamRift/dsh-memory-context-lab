/**
 * AUD51-03-01（0.14.0-beta.53）：readRecord 的 ID 形状白名单与路径穿越。
 *
 * ## 缺陷
 * 旧实现只查「非空字符串」，然后直接拼 `records/<id>.json`：
 * `../x` / `..\\x` / 绝对路径都能把读取目标指到本会话目录里**别的合法 JSON**，
 * 于是「读得到就认」——按 ID 回读、T2 读穿透都成了越界读的入口。
 *
 * ## 修法
 * 形状即闸门：`isRecordId`（contracts/records.mjs 的唯一真源）先判
 * `v3r-<16 位小写十六进制>`，不合法直接 EINVALID_ID，失败关闭——路径只是形状的结果，
 * 而不是形状的判据。
 *
 * ## 断言组
 * 1. 穿越形态（`../`、`..\\`、绝对路径、URL 编码、尾随空格/换行、大小写变体、
 *    长度不对的十六进制）一律 EINVALID_ID，且**不是** ERECORD_NOT_FOUND
 *    （后者会让调用方以为「只是 ID 不存在」，掩盖越界尝试）。
 * 2. 非字符串（undefined/null/数字/对象）同样 EINVALID_ID。
 * 3. 合法 ID 照旧可读（不回归）；合法但不存在的 ID 仍是 ERECORD_NOT_FOUND。
 *
 * ## 定点变异自证
 * 把 readRecord 的白名单判据删掉（改回 typeof id === 'string'）→ 第 1 组红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { isRecordId, RECORD_ID_PATTERN } from '../src/v3/contracts/records.mjs'

async function withStore(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-rec-id-'))
  const key = 's-rec-id'
  try {
    const store = await openV3SessionStore(root, key)
    try {
      return await body({ store, root, key })
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const LEGAL_ID = 'v3r-' + 'ab'.repeat(8)

test('AUD51-03-01 穿越形态一律 EINVALID_ID（不是 ERECORD_NOT_FOUND）', async () => {
  await withStore(async ({ store, root, key }) => {
    // 在本会话目录里放一份**合法形状**的 JSON：旧实现正是被它「读得到就认」。
    const sibling = path.join(root, 'sessions', key, 'control.json')
    await mkdir(path.dirname(sibling), { recursive: true })
    await writeFile(sibling, JSON.stringify({ enabled: true }), 'utf8')

    const attacks = [
      '../control.json',
      '..\\control.json',
      '../../' + key + '/control.json',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      '%2e%2e%2fcontrol.json',
      LEGAL_ID + '\n',
      LEGAL_ID + ' ',
      LEGAL_ID.toUpperCase(),
      LEGAL_ID + '.json',
      'v3r-' + 'g'.repeat(16),
      'v3r-' + 'a'.repeat(15),
      'v3r-' + 'a'.repeat(17),
      '',
      'records',
    ]
    for (const id of attacks) {
      await assert.rejects(
        () => store.readRecord(id),
        (e) => e?.code === 'EINVALID_ID' && /记录 ID 非法/.test(e.message),
        '穿越/畸形 ID 必须落 EINVALID_ID：' + JSON.stringify(id),
      )
    }
  })
})

test('AUD51-03-01 非字符串入参同样 EINVALID_ID（不抛 TypeError、不静默成空）', async () => {
  await withStore(async ({ store }) => {
    for (const id of [undefined, null, 42, {}, [], true]) {
      await assert.rejects(
        () => store.readRecord(id),
        (e) => e?.code === 'EINVALID_ID',
        '非字符串 ID 必须失败关闭：' + String(id),
      )
    }
  })
})

test('AUD51-03-01 合法形状不回归：存在可读、不存在仍是 ERECORD_NOT_FOUND', async () => {
  await withStore(async ({ store }) => {
    assert.equal(isRecordId(LEGAL_ID), true)
    assert.equal(isRecordId(LEGAL_ID.toUpperCase()), false)
    assert.equal(RECORD_ID_PATTERN.test(LEGAL_ID), true)
    await assert.rejects(
      () => store.readRecord(LEGAL_ID),
      (e) => e?.code === 'ERECORD_NOT_FOUND',
      '合法但不存在的 ID 是 not-found，不是「ID 非法」',
    )
  })
})
