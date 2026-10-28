/**
 * T2 隔离提供者真实进程冒烟（0.14.0-beta.35）。
 *
 * 在临时隔离根里跑完整链路：probe → mirror write → cg 检索 → 融合 → forget。
 * 不写正式灵枢根；只用于验收，不挂进 npm test（真实 Python 依赖不应当成为单测前提）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveT2Isolated } from '../src/v3/adapters/host/t2-environment.mjs'
import { probeT2Isolated } from '../src/v3/adapters/retrieval/t2-probe.mjs'
import { createT2IsolatedProvider } from '../src/v3/adapters/retrieval/t2-isolated-provider.mjs'

const RECORD_ID = 'v3r-0123456789abcdef'
const TEXT = '隔离检索验证：蓝鲸协议 alpha-7391 的记忆镜像'

function fakeT1() {
  return {
    async search() { return { display: [], pack: [], dropped: [], oovTerms: [] } },
    async read() { return { text: 'local', record: { id: RECORD_ID, createdAt: 1 } } },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'fake-t1', tier: 'T1' } },
  }
}

async function main() {
  const resolved = await resolveT2Isolated()
  if (resolved === null) {
    console.error('[t2-provider-smoke] 找不到 dsh-memory 环境；用 MEMORY_LAB_T2_REPO 指定包根。')
    return 2
  }
  const base = await mkdtemp(join(tmpdir(), 'mcl-t2-provider-'))
  const isolatedRoot = join(base, 't2-mdcg')
  let provider = null
  try {
    const described = await probeT2Isolated({
      root: isolatedRoot,
      repoRoot: resolved.repoRoot,
      python: resolved.python,
      version: resolved.version,
      timeoutMs: 60000,
    })
    if (described.smokePassed !== true) {
      console.error('[t2-provider-smoke] 探测失败：' + JSON.stringify({ error: described.error, stderr: described.stderr }))
      return 1
    }
    provider = createT2IsolatedProvider({
      t1: fakeT1(),
      client: described.handle,
      sessionKey: 'mcl-e2e',
      root: isolatedRoot,
      metrics: { counter() {}, observe() {} },
    })
    provider.mirrorRecord({
      id: RECORD_ID,
      sessionKey: 'mcl-e2e',
      kind: 'message-user',
      payload: { text: TEXT },
      provenance: { sourceEventId: 'dsh-1' },
    })
    await provider.flush()
    const stats = provider.mirrorStats()
    console.log('[t2-provider-smoke] mirror=' + JSON.stringify(stats))
    if (stats.mirrored !== 1) return 1

    const found = await provider.search('蓝鲸协议 alpha-7391', { limit: 10, packMinScore: 0.5 })
    console.log('[t2-provider-smoke] search=' + JSON.stringify({
      externalHits: found.externalHits,
      sourceLabel: found.sourceLabel,
      ids: found.display.map((hit) => hit.id),
    }))
    if (!found.display.some((hit) => hit.id === RECORD_ID)) return 1

    const forgotten = await provider.forgetRecords([RECORD_ID])
    console.log('[t2-provider-smoke] forget=' + JSON.stringify(forgotten))
    if (forgotten.forgotten !== 1) return 1
    // 撤销遗忘路径：同一 ID 再写一次，验证镜像可恢复（不是永久 ID 冲突）。
    provider.mirrorRecord({
      id: RECORD_ID,
      sessionKey: 'mcl-e2e',
      kind: 'message-user',
      payload: { text: TEXT },
      provenance: { sourceEventId: 'dsh-1' },
    }, { undo: true })
    await provider.flush()
    console.log('[t2-provider-smoke] re-mirror=' + JSON.stringify(provider.mirrorStats()))
    if (provider.mirrorStats().mirrorFailed !== 0) return 1
    if (provider.mirrorStats().mirrored !== 2) return 1
    return 0
  } finally {
    try { await provider?.close?.() } catch { /* 已由脚本内 close 关闭 */ }
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('[t2-provider-smoke] 未捕获异常：' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 1
})