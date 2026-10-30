/**
 * B3-13/14/15/16（AUD50-06-02…05）命令面四条：
 * - B3-13 restore <n> 先判 result.error 再分类，三态各有文案，不再掩成 unknown；
 * - B3-14 verify all 零引用回 success 空态（与 file-status 口径一致）；
 * - B3-15 help（USAGE + input.hint）含 set gate / unset gate；子命令与 help 交叉核对守卫；
 * - B3-16 unpin 按实际删除数回报；pinRecords 返回 removed/unchanged。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { restoreFailureLine } from '../src/index.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const INDEX = new URL('../src/index.mjs', import.meta.url)

test('B3-13 restoreFailureLine：三态与超限各有文案，不再 unknown', () => {
  assert.ok(restoreFailureLine({ error: 'not-ready' }, 3).includes('未就绪'))
  assert.ok(!restoreFailureLine({ error: 'not-ready' }, 3).includes('unknown'))
  assert.ok(restoreFailureLine({ error: 'host-no-surface' }, 3).includes('活动面'))
  assert.ok(!restoreFailureLine({ error: 'host-no-surface' }, 3).includes('unknown'))
  const notFound = restoreFailureLine({ restored: false, reason: 'voucher-not-found' }, 3)
  assert.ok(notFound.includes('凭证不存在') && notFound.includes('history'), '凭证不存在要有指引')
  assert.ok(!notFound.includes('unknown'))
  const tooLarge = restoreFailureLine({ restored: false, reason: 'restore-too-large', chars: 20000, maxChars: 16000 }, 3)
  assert.ok(tooLarge.includes('20000') && tooLarge.includes('16000'), '超限保留体积与预算')
  assert.ok(restoreFailureLine({ restored: false, reason: 'receipt-changed' }, 3).includes('receipt-changed'), '其余 reason 照实透传')
})

test('B3-16 pinRecords：unpin 回报实际删除数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-unpin-'))
  const handlers = new Map()
  const ctx = { on(n, h) { handlers.set(n, h); return () => handlers.delete(n) }, logger: { warn() {}, info() {} } };
  ctx.preStep = async (session) => handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-unpin'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    session.pushUser('落一条记录')
    await ctx.preStep(session)
    await engine._waitForIdle()
    const { readdir } = await import('node:fs/promises')
    const recordFile = (await readdir(path.join(root, 'sessions', id, 'records'))).filter((f) => f.endsWith('.json'))[0]
    const recordId = recordFile ? recordFile.slice(0, -5) : null
    assert.ok(recordId, '已有一条记录可 pin')
    const pinned = await engine.pinRecords(id, [recordId]);
    assert.deepEqual(pinned.pins, [recordId])
    const removedReal = await engine.pinRecords(id, [recordId], { remove: true });
    assert.equal(removedReal.removed, 1, '真实 unpin：removed=1')
    assert.equal(removedReal.unchanged, 0)
    assert.deepEqual(removedReal.pins, [])
    const removedNone = await engine.pinRecords(id, ['v3r-00000000000dead'], { remove: true });
    assert.equal(removedNone.removed, 0, '不存在的 ID：removed=0（命令面不再报已取消 1 条）')
    assert.equal(removedNone.unchanged, 1)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-14/15 静态守卫：verify 空态、help 含 gate、子命令与 help 交叉核对', async () => {
  const source = await readFile(INDEX, 'utf8')
  // B3-14：verify 的 no-matching-reference 转成功空态
  assert.ok(source.includes("result.error === 'no-matching-reference'"), 'verify 空态分支存在')
  assert.ok(source.includes('暂无文件引用，或引用 ID 与任何记录不匹配'))
  // B3-15：help 两处都含 set gate
  assert.ok(source.includes('set gate <0–95>'), 'input.hint 含 set gate')
  assert.ok(/set gate <0–95> \/ unset gate/.test(source), 'USAGE 含 set gate / unset gate')
  // B3-15 交叉核对：dispatch 里每个 sub === '…' 子命令都必须出现在 input.hint 里
  const hintMatch = source.match(/input: \{ hint: '([^']+)' \}/);
  assert.ok(hintMatch, 'input.hint 存在')
  const hint = hintMatch[1]
  const subs = [...source.matchAll(/sub === '([a-z-]+)'/g)].map((m) => m[1])
  const unique = [...new Set(subs)]
  for (const sub of unique) {
    assert.ok(hint.includes(sub), '子命令必须在 help 可发现：' + sub)
  }
  assert.ok(unique.includes('verify') && unique.includes('restore') && unique.includes('unpin'), '抽取器抽到了真子命令（防恒绿）')
})
