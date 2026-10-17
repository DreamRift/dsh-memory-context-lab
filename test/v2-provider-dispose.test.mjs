/**
 * K6 回归：复合检索提供者的停机路径必须把增量日志并入 base。
 *
 * 判据（两条都要成立）：
 *   ① closeAll() 之后磁盘不得留悬空 lexical-index.log（0 字节或不存在）；
 *   ② base 自足——删掉日志后，一个全新实例仍必须查到停机前写入的第二批记录。
 *
 * 阳性对照：若提供者只 clear 不 dispose，本测试必红（日志仍非空）。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME，不依赖任何外部进程。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLocalLexicalBackend } from '../src/v2/local-lexical-backend.mjs'
import { createCompositeRetrievalBackendProvider } from '../src/v2/retrieval-backend-provider.mjs'

const BASE = 'lexical-index.json'
const LOG = 'lexical-index.log'

function record(id, text, seq = 1) {
  return {
    id,
    kind: 'projection-span',
    fidelity: 'synthesized',
    seq,
    refs: {},
    inline: {},
    payload: null,
    text,
    textTruncated: false,
    textIntegrity: 'ok',
    textMaxBytes: 8192,
  }
}

async function sizeOrZero(p) {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

test('K6：closeAll() 归并日志且 base 自足（不留悬空日志、新实例仍可查）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-provider-'))
  try {
    const provider = createCompositeRetrievalBackendProvider({ forcedMode: 'local-lexical-v1' })
    const started = await provider.ensureBackend({ sessionId: 's1', storeRoot: dir })
    assert.equal(started.ok, true)

    // 第一批：base 与 log 都不存在 ⇒ 直接建 base。
    await started.backend.index([record('r1', '厨房里做饭', 1)])
    // 第二批：只应追加日志，不得重写 base。
    await started.backend.index([record('r2', '打扫客厅', 2)])

    assert.ok(await sizeOrZero(path.join(dir, LOG)) > 0, '前提：第二批后必须存在非空增量日志')
    assert.ok(await sizeOrZero(path.join(dir, BASE)) > 0, '前提：首批必须已建立 base')

    await provider.closeAll()

    // ① 不留悬空日志
    assert.equal(await sizeOrZero(path.join(dir, LOG)), 0, '停机后不得留悬空日志（应为 0 字节或不存在）')

    // ② base 自足：日志已空，全新实例仍须从 base 查到第二批记录
    const fresh = createLocalLexicalBackend({ directory: dir })
    assert.deepEqual(await fresh.query('打扫', { limit: 5 }), ['r2'], 'base 必须自足（不得依赖已被清空的日志）')
    assert.deepEqual(await fresh.query('厨房', { limit: 5 }), ['r1'], '首批记录必须仍在')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
