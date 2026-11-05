/**
 * P2-02（0.15.1）：`readProvenance` 缺记录 ID 形状白名单 → 读路径穿越。
 *
 * ## 缺陷
 * `readRecord` 有 `isRecordId` 形状闸（`v3r-<16 位小写十六进制>`），但 `readProvenance`
 * 只查「非空字符串」就 `path.join(dir, 'records', id + '.json')`。于是
 * `../evil` / `..\\evil` / 绝对路径都能把读指针挪到会话目录里**别的合法 JSON** 上，
 * 读得到就认——这是读路径穿越：来源元数据（它会被用来反推摄入断点、决定重放）被伪造。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-02（审计 AUD51-03-01 同族）；
 * 用户裁定（2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法
 * 形状判据**复用** `readRecord` 的同一处 `isRecordId`（契约层真源），不再各写一套：
 * 非法形状一律 `EINVALID_ID` 失败关闭，路径拼接根本不发生。
 *
 * ## 断言组
 * 1. 穿越形状（`../evil`、`..\\evil`、绝对路径、`x/../../evil`、带 .json 后缀）一律
 *    `EINVALID_ID`，且**没有**返回攻击目标的 provenance；
 * 2. 对照：会话目录里真的放一个合法 JSON 作为攻击目标——旧实现会读到它，新实现读不到
 *    （证明这条用例确实覆盖了穿越路径，而不是只测到参数校验）；
 * 3. 合法 ID 仍可读（不误杀），返回值只含三类来源字段。
 *
 * ## 不适用条件与已知边界
 * - 只守「按 ID 读」这一条路径；记录目录里非 `v3r-*` 的残留由打开期 quarantine 处理。
 * - 不覆盖符号链接形式的目录替换（文件系统层信任边界之外）。
 *
 * ## 定点变异自证
 * 把 `isRecordId` 判据退回「非空字符串」→ 组 1/2 红；恢复后全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const LF = String.fromCharCode(10)
const KEY = 's-p202'
const hex16 = (n) => n.toString(16).padStart(16, '0')

function recordOf(n, text) {
  return {
    id: 'v3r-' + hex16(n),
    kind: 'message-user',
    sessionKey: KEY,
    createdAt: 1,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + n, sourceForm: 'live', transactionId: 'tx-' + n },
  }
}

async function seeded() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p202-'))
  const store = await openV3SessionStore(root, KEY)
  await store.submitTransaction([recordOf(1, '正常记录')])
  // 攻击目标：会话目录里一个**合法** JSON（旧实现按 ../evil 就能读到它）
  const dir = path.join(root, 'sessions', KEY)
  await writeFile(path.join(dir, 'evil.json'), JSON.stringify({
    provenance: { sourceEventId: 'FORGED', sourceForm: 'forged', transactionId: 'forged-tx' },
  }) + LF)
  return { root, store, dir }
}

test('P2-02 穿越形状一律 EINVALID_ID，且读不到攻击目标', async () => {
  const { root, store, dir } = await seeded()
  const rel = path.relative(path.join(dir, 'records'), path.join(dir, 'evil.json')) // '../evil.json'
  const attacks = [
    '../evil',
    '..' + path.sep + 'evil',
    path.join(dir, 'evil'),          // 绝对路径（无后缀）
    path.join(dir, 'evil.json'),
    'x/../../evil',
    'v3r-' + hex16(1) + '/../evil',
    '',
    '   ',
    null,
    42,
  ]
  try {
    for (const attack of attacks) {
      await assert.rejects(
        () => store.readProvenance(attack),
        (error) => error?.code === 'EINVALID_ID' || error?.name === 'V3ContractViolation',
        '非法 ID 必须失败关闭：' + JSON.stringify(attack),
      )
    }
    // 真实穿越目标的相对形态也要挡住（含 .json 后缀的那条）
    await assert.rejects(() => store.readProvenance(rel.replace(/\.json$/, '')), (e) => e?.code === 'EINVALID_ID')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-02 合法 ID 仍可读（不误杀），且只返回来源三元组', async () => {
  const { root, store } = await seeded()
  try {
    const provenance = await store.readProvenance('v3r-' + hex16(1))
    assert.deepEqual(provenance, { sourceEventId: 'evt-1', sourceForm: 'live', transactionId: 'tx-1' })
    assert.deepEqual(Object.keys(provenance).sort(), ['sourceEventId', 'sourceForm', 'transactionId'])
    // 等价性：readRecord 与 readProvenance 对同一 ID 的合法性判据必须一致（同一真源）
    for (const bad of ['../evil', 'x', 'v3r-zz']) {
      const a = await store.readProvenance(bad).then(() => 'ok', (e) => e?.code ?? e?.name)
      const b = await store.readRecord(bad).then(() => 'ok', (e) => e?.code ?? e?.name)
      assert.equal(a, b, '两条读路径的形状判据必须一致：' + bad + ' → ' + a + ' vs ' + b)
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
