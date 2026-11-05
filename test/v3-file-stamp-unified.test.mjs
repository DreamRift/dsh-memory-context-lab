/**
 * P3-01 戳口径统一 —— 会话状态面与派生索引/账本必须用**同一个**文件戳判据。
 *
 * 缺陷（0.15.1 独立排查报告 §3.3 P3-01）：`session-state.mjs` / `session-control.mjs` 用
 * `mtimeMs:size`，而 `file-stamp.mjs`（索引）与 `session-store.mjs` 的隐私账本用
 * `mtimeNs:size:头 64 字节 sha1`。两套判据必然漂移，且毫秒戳在 Windows 1–15ms 计时粒度内
 * **同大小**替换会判等 —— 热路径继续用进程内旧值。这是失败开放的方向：该关的开关没关、
 * 已经 forget 的记录仍按旧状态可见。
 *
 * 判据来源：`src/v3/adapters/storage/file-stamp.mjs`（唯一实现，导出 fileStampOf /
 * fileStampOfSync / STAMP_HEAD_BYTES / STAMP_ABSENT）。
 *
 * 断言组：
 * A. 同大小 + 同 mtimeMs 的原地替换，state/control 热路径必须看见（旧判据必红）；
 * B. 同步戳与异步戳对同一文件给出**逐字符相同**的戳（含 absent 哨兵）；
 * C. 静态守卫：src 内不得再出现 `mtimeMs + ':'` 形式的戳拼接（防第三套判据回流）；
 * D. ENOENT 哨兵仍生效（文件出现后立即可见），不因换戳回退成「永久缓存空值」。
 *
 * 不适用条件与已知边界：
 * - 只保证「头 64 字节内的差异」可见；同大小、同 mtime、且**头 64 字节完全相同**的替换
 *   仍判等（无法区分字节）——这是本判据的已知边界，不是回归；
 * - 网络盘上 mtimeNs 精度可能退化到毫秒，此时仍由头 sha1 兜底（同大小头部变化可见）。
 *
 * 定点变异自证（`node --test test/v3-file-stamp-unified.test.mjs`）：
 * - 把 session-control 的 `fileStampOfSync(path)` 换回 `statSync(path).mtimeMs + ':' + size`
 *   → A 组红（返回旧 enabled）；
 * - 把 session-state / session-control 的 import 改成各自本地实现 → C 组红；
 * - 恢复后 4 组全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from 'node:fs/promises'
import { statSync, readFileSync, readdirSync, statSync as statOf } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fileStampOf, fileStampOfSync, STAMP_ABSENT } from '../src/v3/adapters/storage/file-stamp.mjs'
import { readSessionControl, sessionControlPath, writeSessionControl } from '../src/v3/adapters/storage/session-control.mjs'
import { readSessionState, sessionStatePath, writeSessionState } from '../src/v3/adapters/storage/session-state.mjs'

const FIXED_SECONDS = 1700000000 // 固定的秒级时间戳：让「同 mtimeMs」成为确定性前提

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdirPath(), 'mcl-v3-stampunified-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function tmpdirPath() {
  return (process.env.TEMP || process.env.TMPDIR || '/tmp')
}

/** 写入并**把 mtime 钉死**到 FIXED_SECONDS：使「mtimeMs 相同」由构造保证，不靠运气。 */
async function writePinned(file, text) {
  await writeFile(file, text, 'utf8')
  await utimes(file, FIXED_SECONDS, FIXED_SECONDS)
}

test('P3-01-A 同大小 + 同 mtimeMs 的替换：状态面热路径必须看见', async () => {
  await withRoot(async (root) => {
    const controlPath = sessionControlPath(root, 'p301c')
    const statePath = sessionStatePath(root, 'p301s')
    await mkdir(path.dirname(controlPath), { recursive: true })
    await mkdir(path.dirname(statePath), { recursive: true })

    // 关键：两份 JSON 必须**同字节长**，否则 size 变了，旧判据也能看见。
    // 用同一个键的数字位数对齐（1 位 → 1 位），既保持合法形状又保证长度相等。
    const c1 = '{"schemaVersion":1,"overrides":{"limit":10}}'
    const c2 = '{"schemaVersion":1,"overrides":{"limit":11}}'
    assert.equal(c1.length, c2.length, '前置条件：控制文件两份必须同字节长')

    await writePinned(controlPath, c1)
    assert.equal(readSessionControl(root, 'p301c').overrides.limit, 10, '初读拿到 limit=10 并进缓存')

    await writePinned(controlPath, c2)
    const pinned = statSync(controlPath)
    assert.equal(Math.floor(pinned.mtimeMs), FIXED_SECONDS * 1000, '前置条件：mtimeMs 必须被钉死在固定值')
    assert.equal(pinned.size, c1.length, '前置条件：size 未变')
    assert.equal(readSessionControl(root, 'p301c').overrides.limit, 11, '同毫秒同大小替换必须可见（旧 mtimeMs:size 判据在此判等 → 红）')

    const s1 = '{"schemaVersion":1,"updatedAt":0}'
    const s2 = '{"schemaVersion":1,"updatedAt":1}'
    assert.equal(s1.length, s2.length, '前置条件：状态文件两份必须同字节长')
    await writePinned(statePath, s1)
    assert.equal(readSessionState(root, 'p301s').updatedAt, 0)
    await writePinned(statePath, s2)
    assert.equal(readSessionState(root, 'p301s').updatedAt, 1, '状态文件同理：同毫秒同大小替换必须可见')
  })
})

test('P3-01-B 同步戳与异步戳同源同格式（含 absent 哨兵）', async () => {
  await withRoot(async (root) => {
    const file = path.join(root, 'x.json')
    assert.equal(fileStampOfSync(file), STAMP_ABSENT)
    assert.equal(await fileStampOf(file), STAMP_ABSENT)
    await writeFile(file, '{"a":1}\n', 'utf8')
    const first = fileStampOfSync(file)
    assert.equal(first, await fileStampOf(file), '两个入口必须是同一判据（否则又是两套戳）')
    // 同大小替换（8 字节 → 8 字节），并把 mtime 钉死：只有头 sha1 能看见这次变化。
    await writePinned(file, '{"a":2}\n')
    assert.equal(statSync(file).size, 8, '前置条件：替换后仍是 8 字节')
    const second = fileStampOfSync(file)
    assert.notEqual(second, first, '同大小替换必须判异（头 64 字节摘要覆盖）')
    assert.equal(second, await fileStampOf(file), '判异后两入口仍须一致')
  })
})

test('P3-01-C 静态守卫：src 内不得再出现 mtimeMs 戳拼接', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.mjs')) continue
      const text = readFileSync(full, 'utf8')
      // 戳拼接的唯一合法写法是 file-stamp.mjs 里的 stampOfStat()；
      // 这里禁的是「mtimeMs 拼成戳」的旧形态（mtimeMs 作为普通数据字段不受影响）。
      if (/\.mtimeMs\s*\+\s*['":]/.test(text)) offenders.push(path.relative(srcRoot, full))
    }
  }
  walk(srcRoot)
  assert.deepEqual(offenders, [], '状态/控制/账本必须共用 file-stamp.mjs（出现第二套毫秒戳即判红）')
})

test('P3-01-D ENOENT 哨兵后文件出现仍可见（换戳不得回退成永久空值）', async () => {
  await withRoot(async (root) => {
    const controlPath = sessionControlPath(root, 'p301d')
    await mkdir(path.dirname(controlPath), { recursive: true })
    assert.equal(readSessionControl(root, 'p301d').enabled, true, '不存在 = 默认全开')
    await writeSessionControl(root, 'p301d', { enabled: false })
    assert.equal(readSessionControl(root, 'p301d').enabled, false, '文件出现后立即可见')
    await writeSessionState(root, 'p301d', { mode: 'full-history' })
    assert.equal(readSessionState(root, 'p301d').mode, 'full-history')
    const raw = JSON.parse(await readFile(sessionStatePath(root, 'p301d'), 'utf8'))
    assert.equal(raw.schemaVersion, 1)
    assert.ok(statOf(sessionStatePath(root, 'p301d')).size > 0)
  })
})
