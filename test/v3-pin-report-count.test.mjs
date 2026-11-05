/**
 * P2-15（0.15.1）：`pin` 按请求数而非实际新增数回报（`unpin` 已修，pin 未对称）。
 *
 * ## 缺陷
 * `/memory-lab pin <id…>` 曾直接回报 `'已 pin ' + ids.length + ' 条'`——那是**请求条数**，
 * 不是实际发生变化条数。对已经 pin 过的 ID 再 pin 一次，用户看到「已 pin 1 条」，
 * 而 pin 集合一个元素都没多。这与同目录 `unpin` 的既有口径（B3-16：按**实际删除数**回报）
 * 自相矛盾：同一个命令族的两半用两把尺。
 *
 * 后果不是丢数据，而是**观测失真**：用户/排障者据此判断「pin 保护生效了 N 条」，
 * 实际保护面没变；批量脚本还会把「重复 pin 全部无变化」误读成「新增了 N 条」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-15（审读）；
 * unpin 的既有口径见 src/index.mjs 的 B3-16 注释与 test/v3-command-surface.test.mjs。
 *
 * ## 修法
 * `pinRecords` 在**锁内**数 `added`（只数真正新增的），随返回值一起给出；`unchanged`
 * 改为「既没新增也没删除」的条数。命令面按 `added` 回报，全无新增时明说「没有新增 pin
 * （N 条此前已 pin）」。与 unpin 完全对称。
 *
 * ## 断言组
 * 1. 全新 ID → `added` = 请求数，`unchanged` = 0，命令面说「已 pin N 条」；
 * 2. 重复 pin 同一 ID → `added` = 0，命令面**不得**说「已 pin 1 条」；
 * 3. 混合（1 新 + 1 旧）→ `added` = 1，文案同时给出请求数与已 pin 数；
 * 4. `unpin` 的既有口径不回归（removed 仍按实际删除数）。
 *
 * ## 不适用条件与已知边界
 * - 只改**回报文案与计数**，不改 pin 集合本身的语义（幂等、owner、失败关闭都不动）。
 * - 状态文件损坏时仍失败关闭（`error`），此时 added/removed 都为 0。
 *
 * ## 定点变异自证
 * 命令面退回 `ids.length` → 组 2/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFakeSession } from './helpers/fake-session.mjs'

const ENTRY = path.join(process.cwd(), 'src', 'index.mjs')

async function withEntry(body) {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-p2-15-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const listeners = []
  const registered = []
  const stub = {
    logger: { warn() {}, info() {}, error() {} },
    on(event, handler) { listeners.push({ event, handler }); return () => {} },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    inject() { return { dispose() {} } },
    commands: { register(definition) { registered.push(definition); return () => {} } },
  }
  try {
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    await module.apply(stub, { enabled: true, packMinScore: 0 })
    const session = createFakeSession({ id: 'p2-15' })
    // 两条独立记录：混合请求用例需要「一旧一新」两个真实 ID。
    session.pushUser('P2-15 pin 回报 甲 ' + '材料'.repeat(120))
    session.pushUser('P2-15 pin 回报 乙 ' + '材料'.repeat(120))
    const run = (rawInput) => registered[0].handler({ rawInput, agent: { session } })
    await run('on')
    const ingestListener = listeners.find((row) => row.event === 'agent/pre-step')
    await ingestListener.handler({ agent: { session }, signal: { aborted: false }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    for (let i = 0; i < 600; i += 1) {
      const text = (await run('status')).text ?? ''
      const m = /已摄入 (\d+)/.exec(text)
      if (m !== null && Number(m[1]) >= 2 && !text.includes('后台摄入进行中')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    return await body({ run })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** 用 recall 取一条已摄入记录的真实 ID（`list` 不是命令面的一员）。 */
async function recordIds(run, { atLeast = 1 } = {}) {
  const out = await run('recall 材料')
  const ids = [...new Set((out.text ?? '').match(/v3r-[0-9a-f]{16}/g) ?? [])]
  assert.ok(ids.length >= atLeast, '前置：recall 必须至少命中 ' + atLeast + ' 条记录（得到 ' + ids.length + '）：' + (out.text ?? '').slice(0, 160))
  return ids
}

test('P2-15 全新 ID：按实际新增数回报', async () => {
  await withEntry(async ({ run }) => {
    const [id] = await recordIds(run)
    const out = await run('pin ' + id)
    assert.equal(out.kind, 'success', JSON.stringify(out).slice(0, 200))
    assert.match(out.text, /已 pin 1 条/, '全新 ID 必须报新增 1 条')
  })
})

test('P2-15 重复 pin 同一 ID：不得再说「已 pin 1 条」', async () => {
  await withEntry(async ({ run }) => {
    const [id] = await recordIds(run)
    await run('pin ' + id)
    const again = await run('pin ' + id)
    assert.equal(again.kind, 'success')
    assert.equal(/已 pin 1 条/.test(again.text), false,
      '重复 pin 没有任何新增，不得回报「已 pin 1 条」（旧实现按请求数）：' + again.text)
    assert.match(again.text, /没有新增 pin/, '必须明说本次没有新增')
  })
})

test('P2-15 混合请求：新增数与请求数都如实给出', async () => {
  await withEntry(async ({ run }) => {
    const ids = await recordIds(run, { atLeast: 2 })
    await run('pin ' + ids[0])
    // 一旧一新：请求 2 条，实际只新增 1 条。
    const mixed = await run('pin ' + ids[0] + ' ' + ids[1])
    assert.equal(mixed.kind, 'success')
    assert.match(mixed.text, /已 pin 1 条/, '只有 1 条是新增的')
    assert.match(mixed.text, /请求 2 条/, '必须给出用户请求的条数（差额可解释）')
  })
})

test('P2-15 unpin 口径不回归：仍按实际删除数回报', async () => {
  await withEntry(async ({ run }) => {
    const [id] = await recordIds(run)
    await run('pin ' + id)
    const first = await run('unpin ' + id)
    assert.match(first.text, /已取消 pin 1 条/)
    const second = await run('unpin ' + id)
    assert.match(second.text, /没有匹配的 pin 记录/, '再 unpin 同一条必须说没有匹配（不是「已取消 1 条」）')
  })
})
