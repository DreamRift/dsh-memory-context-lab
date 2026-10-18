/**
 * 真实隔离灵枢集成测试：保存 → 索引 → 检索命中 → 按记录 ID 回源读权威原文。
 *
 * 这不是 mock：它起真实的 `md_cg.mcp_server` Python 子进程，root 全部指向临时目录
 * （`buildIsolatedMdcgEnvironment` 会剔除父进程 MDCG_* 并改写全部根），**绝不触碰
 * 正式灵枢库**。环境缺 Python / 缺 dsh-memory 包时如实 SKIP 并打印原因，
 * 不静默改成 mock 然后宣布集成通过。
 *
 * 覆盖（对应本轮验收项）：
 * 1. 真实写入/索引 → 查询 → 命中 → 按源 ID 回读；
 * 2. 命中的是**记录 ID**（可兑现），不是无法定位的节点名；
 * 3. 索引里的只是派生摘录；权威原文始终来自 ArchiveStore，按 ID 回读一致；
 * 4. 重复索引幂等：同 ID 重写不产生第二份记忆、不改变记录身份；
 * 5. 后端不可用时如实报不可用，不回退正式库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { syncRetrievalIndex, searchRecords } from '../src/v2/retrieval.mjs'
import { readRecordById } from '../src/v2/readback.mjs'
import { createLingshuBackendProvider, LINGSHU_BACKEND_NAME } from '../src/v2/lingshu-backend.mjs'
import { locatePinnedDshMemory } from '../src/dsh-memory-suppression.mjs'

const requireFromPlugin = createRequire(import.meta.url)
const SESSION_ID = 'session-lingshu-integration-01'

/** 把「沙箱禁止管道」与「真的没装 Python」分开报，两者排查方向完全不同。 */
function sandboxReasonOf(error) {
  const code = error?.code ?? ''
  const message = String(error?.message ?? error ?? '')
  if (code === 'EPERM' || message.includes('EPERM')) {
    return '受限沙箱禁止子进程管道（EPERM）；真实隔离灵枢集成需要在放宽沙箱的终端里跑'
  }
  return `python 启动失败：${message || code}`
}

/**
 * 环境探测：Python、dsh-memory 包、以及**带管道的子进程**都要真的可用，
 * 否则 SKIP（不假装通过）。
 *
 * 三项都要探，因为它们各自会以不同方式让集成失败，而失败原因必须准确：
 * - 缺 Python → 环境缺依赖；
 * - 缺 dsh-memory → 没装灵枢；
 * - 管道 EPERM → **沙箱边界**，不是产品缺陷，也不是「没装 Python」。
 * 把沙箱限制报成依赖缺失会误导排查方向，所以这里显式区分。
 */
async function environment() {
  const probe = await new Promise((resolve) => {
    let child
    try {
      child = spawn('python', ['-c', 'import sys'], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) {
      resolve({ ok: false, reason: sandboxReasonOf(error) })
      return
    }
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    child.on('error', (error) => finish({ ok: false, reason: sandboxReasonOf(error) }))
    child.on('close', (code) => finish(code === 0
      ? { ok: true }
      : { ok: false, reason: `python 退出码 ${code}` }))
  })
  if (!probe.ok) return probe

  let located
  try {
    located = await locatePinnedDshMemory(requireFromPlugin)
  } catch (error) {
    return { ok: false, reason: `未定位到 @furongjun1999/dsh-memory：${error?.message ?? error}` }
  }
  // 包在 ≠ Python 包可导入。安装体处于半更新/缺依赖状态时，mdcg_remember 会在
  // 服务端抛 ImportError（本机 0.10.1 实测：md_cg.fsutil 缺 node_write_lock）。
  // 那是环境故障，不是插件缺陷；必须在环境探测里分清，别让集成用例报成断言红。
  const health = await importHealth(located.packageRoot)
  if (!health.ok) return { ok: false, reason: `环境：${health.reason}` }
  return { ok: true, packageRoot: located.packageRoot }
}

/**
 * 只匹配**元数据**的字面匹配器：绝不看正文。
 *
 * 这是本测试的前提——正文里那个 marker 只存在于冷库正文，元数据里绝不出现，
 * 所以内置字面一路必然零命中，命中只能来自真实灵枢语义一路。如果匹配器顺手看了
 * 正文，测试就会在「语义后端根本没工作」时也拿到命中，等于自己骗自己。
 */
function literalMatcher(entry, needle) {
  const haystack = [entry.id, entry.kind, entry.refs?.toolName, entry.refs?.callId, entry.inline?.range]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/** 删目录要重试：Windows 上刚退出的子进程句柄可能还没释放。 */
async function removeWithRetry(root, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === attempts) {
        // 清理失败绝不冒泡：在 `finally` 里抛错会顶替掉测试体真正的失败原因
        // （审计现场：真实的 EINVAL 被 EBUSY 覆盖，看起来像环境问题）。
        console.error(`[cleanup] 临时目录未能删除（已保留，不影响判定）：${error?.code ?? ''} ${error?.message ?? error}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

/**
 * `body` 会拿到一个 `register(cleanup)`：把「拆子进程」注册进去，**无论测试体
 * 成功还是断言失败都会先执行**，然后才删目录。
 *
 * 顺序不能反：隔离根里跑着真实的 Python 子进程，进程还活着时 rmdir 会报 EBUSY；
 * 若清理放在 `finally` 且不注册，一次断言失败就会让子进程泄漏、并让 EBUSY 顶替
 * 真实错误（本文件此前就是这样把 `EINVAL` 报成 `EBUSY` 的）。
 */
async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-lingshu-${name}-`))
  const cleanups = []
  try {
    return await body(root, (cleanup) => cleanups.push(cleanup))
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.error(`[cleanup] 拆子进程失败：${error?.message ?? error}`)
      }
    }
    await removeWithRetry(root)
  }
}

/**
 * 给「后端启动 + 索引 + 检索」加超时兜底：真实子进程链路若真回归（挂起、死锁、
 * python 起不来），要**明确失败**而不是把测试进程拖死。基线全程约 3.1s，阈值比
 * 它高一个数量级，正常路径不会被误杀；也不 kill python 子进程（交给 finally 里的
 * closeAll），不改真实链路。
 */
async function withTimeout(step, promise, ms) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`真实灵枢集成超时（${step}，>${ms}ms）——后端疑似挂起，不是断言失败`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 真实 md_cg 能否被 Python 导入（只读探测，不起 MCP 服务）。 */
async function importHealth(packageRoot) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('python', ['-c', 'import md_cg.mcp_server'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONPATH: packageRoot },
      })
    } catch (error) {
      resolve({ ok: false, reason: sandboxReasonOf(error) })
      return
    }
    let stderr = ''
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk)
    })
    child.on('error', (error) => finish({ ok: false, reason: sandboxReasonOf(error) }))
    child.on('close', (code) => finish(code === 0
      ? { ok: true }
      : { ok: false, reason: `md_cg 导入失败（exit ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' / ')}` }))
  })
}

async function seedStore(labRoot, texts) {
  const store = await V2SessionStore.init({ labRoot, sessionId: SESSION_ID })
  const handle = await store.openTransaction()
  const ids = []
  for (const [index, text] of texts.entries()) {
    const draft = draftRecord({
      kind: RECORD_KINDS.PROJECTION_SPAN,
      seq: index + 1,
      fidelity: 'verbatim',
      inline: { nodeId: `n-${index + 1}` },
      refs: { sourceKinds: 'user/message', sourceSeqs: String(index + 1), spanKind: 'history-span' },
      content: text,
    })
    // `stageRecord` 返回的是**已校验的记录对象**（含 `.id`），不是 id 字符串。
    ids.push((await store.stageRecord(handle, draft)).id)
  }
  await store.commitTransaction(handle)
  return { store, ids }
}

test('真实隔离灵枢：索引 → 检索命中记录 ID → 按 ID 回源读权威原文', async (t) => {
  const env = await environment()
  if (!env.ok) {
    t.skip(`跳过真实灵枢集成：${env.reason}`)
    return
  }

  await withTempLab('roundtrip', async (labRoot, register) => {
    // 唯一的检索信号：一个只出现在正文里的词，元数据里绝不出现。
    const marker = 'ZEBRAFISH-CANARY-8842'
    const { store, ids } = await seedStore(labRoot, [
      `这段历史讨论了 ${marker} 的部署细节，结论是先回滚再验证。`,
      '另一段完全无关的历史，只讲目录整理。',
    ])

    const provider = createLingshuBackendProvider({ lingshuPackageRoot: env.packageRoot })
    // 注册而不是只在末尾 close：断言失败时也必须拆掉子进程，否则隔离根被锁住。
    register(() => provider.closeAll())
    const started = await withTimeout('后端启动+sync', provider.ensureBackend({
      sessionId: SESSION_ID,
      storeRoot: store.directory,
      signal: undefined,
    }), 60_000)
    assert.equal(started.ok, true, `隔离灵枢必须能启动：${started.reason ?? ''}`)
    assert.equal(started.backend.name, LINGSHU_BACKEND_NAME)

    // 环境探针：先做一次真实写入。已安装的 md_cg 可能「import 得动、写不进去」
    // （本机 0.10.1 实测：mdcg_remember 在服务端抛 ImportError，而
    // `import md_cg.mcp_server` 本身成功）。只把明确的导入失败归类为环境，
    // 其他失败仍然红——不能拿「环境」掩盖插件的参数/契约回归。
    const probeId = 'probe-lingshu-health-0001'
    const probe = await withTimeout('写入探针', started.backend.index([{
      id: probeId,
      kind: 'projection.span',
      fidelity: 'verbatim',
      seq: 0,
      refs: { spanKind: 'history-span' },
      inline: { nodeId: 'probe-lingshu-health' },
      text: 'isolation health probe',
    }]), 30_000)
    if (Object.keys(probe.externalIds ?? {}).length === 0) {
      const reason = probe.conflicts?.[0]?.reason ?? probe.skipped?.[0]?.reason ?? 'unknown'
      if (/ImportError|ModuleNotFoundError|No module named|node_write_lock/i.test(String(reason))) {
        t.skip(`环境：隔离灵枢写入不可用（${reason}）`)
        return
      }
      assert.fail(`索引探针失败：${reason}`)
    }

    // 1. 索引：把冷库记录（派生摘录 + 记录 ID）交给灵枢。
    //    `indexedNow` 是**条数**，`skippedNow` 才是明细数组。
    const synced = await syncRetrievalIndex({ directory: store.directory, backend: started.backend, store })
    assert.equal(synced.indexedNow, 2, '两条记录都要进索引')
    assert.equal(synced.skippedNow.length, 0, `不应有跳过：${JSON.stringify(synced.skippedNow)}`)
    assert.equal(synced.rebuilt, true, '首次同步应为全量重建')

    // 2. 检索：只用正文词查询，必须命中，且命中的是可兑现的记录 ID。
    const found = await withTimeout('检索', searchRecords({
      store,
      backend: started.backend,
      text: marker.toLowerCase(),
      limit: 10,
      literalMatcher,
    }), 30_000)
    assert.equal(found.semanticUsed, true, '必须真的用了后端，而不是字面降级')
    assert.equal(found.semanticError, null, `后端不得报错：${found.semanticError}`)
    const hitIds = found.records.map((record) => record.id)
    assert.ok(hitIds.includes(ids[0]), `检索必须命中 ${ids[0]}，实际命中 ${JSON.stringify(hitIds)}`)

    // 3. 回源：命中之后一律按记录 ID 读 ArchiveStore 的权威原文，不是读索引摘录。
    const loaded = await readRecordById(labRoot, SESSION_ID, ids[0], { store })
    assert.equal(loaded.ok, true, `按 ID 回读必须成功：${loaded.error ?? ''}`)
    assert.ok(loaded.payloadText.includes(marker), '回读到的必须是权威原文')
    assert.equal(loaded.integrity, 'ok', '回读要报告完整性，而不是只报告成功')

    // 4. 幂等：重复同步不新增记忆、不改记录身份。
    const again = await syncRetrievalIndex({ directory: store.directory, backend: started.backend, store })
    assert.equal(again.indexedNow, 0, '已索引记录不得重复写入灵枢')
    assert.equal(again.rebuilt, false, '第二次同步是增量，不是重建')
    const afterIds = store.listEntries({ limit: 100 }).entries.map((entry) => entry.id)
    assert.deepEqual(afterIds, ids, '重复索引不得改变记录身份或数量')

    // 5. 无答案查询：语义后端返回 top-k 最相关，不保证精确命中；
    //    本断言只保证不编造、真实存在，不要求空命中。
    const miss = await withTimeout('无答案查询', searchRecords({
      store,
      backend: started.backend,
      text: 'QUERY-THAT-MATCHES-NOTHING-9911',
      limit: 10,
      literalMatcher,
    }), 30_000)
    assert.equal(miss.semanticUsed, true, '必须真的用了后端，而不是字面降级')
    assert.equal(miss.semanticError, null, `后端不得报错：${miss.semanticError}`)
    assert.ok(miss.records.length <= 10, `top-k 语义：命中数不得超过 limit，实际 ${miss.records.length}`)
    // 逐个 ID 回源校验：命中的必须是冷库里真实存在的记录，不是后端编造的 ID。
    for (const record of miss.records) {
      assert.ok(
        store.getEntry(record.id) !== null,
        `无答案查询不得编造记录 ID：${record.id} 不在 ArchiveStore 中`,
      )
    }
  })
})

test('真实隔离灵枢：后端不可用时如实报不可用，绝不回退正式库', async () => {
  const provider = createLingshuBackendProvider({ lingshuPackageRoot: '' })
  const described = provider.describe()
  assert.equal(described.available, false)
  assert.match(String(described.reason), /未定位到/)
  assert.equal(provider.backendFor({ sessionId: SESSION_ID, storeRoot: 'C:/nowhere' }), null)
  const started = await provider.ensureBackend({ sessionId: SESSION_ID, storeRoot: 'C:/nowhere' })
  assert.equal(started.ok, false)
  assert.equal(started.backend, null)
})

test('真实隔离灵枢：隔离根指向会话目录，不读写正式灵枢根', async (t) => {
  const env = await environment()
  if (!env.ok) {
    t.skip(`跳过真实灵枢集成：${env.reason}`)
    return
  }
  await withTempLab('isolation', async (labRoot, register) => {
    const { store } = await seedStore(labRoot, ['隔离根验证文本'])
    const provider = createLingshuBackendProvider({ lingshuPackageRoot: env.packageRoot })
    register(() => provider.closeAll())
    const started = await withTimeout('后端启动', provider.ensureBackend({ sessionId: SESSION_ID, storeRoot: store.directory }), 60_000)
    assert.equal(started.ok, true, `隔离灵枢必须能启动：${started.reason ?? ''}`)
    // 索引后，隔离根下必须真的出现灵枢自己的库目录；正式根不参与。
    await syncRetrievalIndex({ directory: store.directory, backend: started.backend, store })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(store.directory)
    assert.ok(
      entries.some((name) => name === 'mdcg' || name === 'state' || name === 'data'),
      `隔离灵枢的根必须落在会话目录下，实际：${JSON.stringify(entries)}`,
    )
  })
})
