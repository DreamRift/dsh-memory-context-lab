/**
 * `/memory-lab t2 backfill` 真实进程验收（0.14.0-beta.38，P1）。
 *
 * 走**真实命令面 + 真实隔离 MCP**，但数据根在临时 DSH_HOME 里：
 * 1. 造一个 65 条记录的会话（60 条可镜像正文 + 5 条 metadata-only）；
 * 2. apply 真实插件入口，`/memory-lab on` → 一次 pre-step 建库（T2 探测走真实 Python）；
 * 3. `/memory-lab t2 backfill 20` → 轮询状态文件直到完成 → 数隔离根 md 节点；
 * 4. 再跑一次同一命令 → 计划量必须为 0（幂等），节点数不变；
 * 5. `/memory-lab t2` 回执必须给出「可镜像 60 / 已镜像 20」与覆盖率；
 * 6. 用独立 MCP 客户端按查询读隔离根，确认回填节点真的可检索。
 *
 * 不写正式灵枢根；不启动/重启 DSH。用法：
 *   node scripts/t2-backfill-smoke.mjs
 * 环境：找不到 dsh-memory 时退出码 2；断言失败退出码 1。
 */
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveT2Isolated } from '../src/v3/adapters/host/t2-environment.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { readBackfillState } from '../src/v3/adapters/storage/t2-backfill-state.mjs'
import { scanMirroredNodes } from '../src/v3/adapters/storage/mirror-inventory.mjs'
import { probeT2Isolated } from '../src/v3/adapters/retrieval/t2-probe.mjs'

const SESSION_KEY = 'session-backfill-smoke'
const SEED_TEXT = 60
const SEED_META = 5
const LIMIT = 20
const COMMAND = '/memory-lab'

function log(message) {
  console.log('[t2-backfill-smoke] ' + message)
}

function fail(message) {
  console.error('[t2-backfill-smoke] 失败：' + message)
  return 1
}

function recordOf(index, text, extra = {}) {
  return {
    id: 'v3r-' + index.toString(16).padStart(16, '0'),
    kind: extra.metaOnly === true ? 'message-assistant' : 'message-user',
    sessionKey: SESSION_KEY,
    createdAt: 1793170000000 + index,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8'), ...(extra.metaOnly === true ? { metaOnly: true, metaReason: 'assistant 无可见文本块' } : {}) },
    provenance: { sourceEventId: 'dsh-' + index, sourceForm: null, transactionId: 'seed-backfill' },
  }
}

function stubContext() {
  const commands = []
  const warnings = []
  const cleanups = []
  const prependHandlers = []
  const pushHandlers = []
  const ctx = {
    warnings,
    logger: { info() {}, warn(message) { warnings.push(String(message)) } },
    get() { return undefined },
    on(event, handler, options) {
      if (event !== 'agent/pre-step') return () => {}
      if (options?.prepend === true) prependHandlers.unshift(handler)
      else pushHandlers.push(handler)
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => { for (const row of cleanups.splice(0).reverse()) row() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    inject(deps, callback) {
      if (deps.includes('sessionProjections')) {
        callback({ ...ctx, sessionProjections: { register() { return () => {} } } })
      }
      return { dispose() {} }
    },
    sessionProjections: { register() { return () => {} } },
    _commands: commands,
    // 真实 cordis 语义：prepend 在外层、push 在内层，两者都收到 next。
    _preStep: async (payload) => {
      const chain = [...prependHandlers, ...pushHandlers]
      if (chain.length === 0) throw new Error('pre-step 未注册')
      let index = 0
      const next = async () => {
        if (index >= chain.length) return { kind: 'enter', messages: [] }
        const handler = chain[index]
        index += 1
        return await handler(payload, next)
      }
      return await next()
    },
    _dispose() { for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup() } catch {} } },
  }
  return ctx
}

function fakeSession() {
  const events = []
  const session = {
    id: SESSION_KEY,
    log: events,
    events: () => events,
    surface: { nodes: [] },
    append() { return { seq: events.length + 1 } },
    eventAt(seq) { return events[seq] },
    deriveMessages() { return [] },
  }
  return session
}

async function invoke(ctx, session, rawInput) {
  const command = ctx._commands[0]
  return await command.handler({ agent: { session }, rawInput })
}

async function waitForState(directory, timeoutMs = 180000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let state = null
    try { state = await readBackfillState(directory) } catch { state = null }
    if (state !== null && state.status !== 'running') return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

async function main() {
  const resolved = await resolveT2Isolated()
  if (resolved === null) {
    console.error('[t2-backfill-smoke] 找不到 dsh-memory 环境；用 MEMORY_LAB_T2_REPO 指定包根。')
    return 2
  }
  log('dsh-memory=' + resolved.repoRoot + ' version=' + resolved.version + ' python=' + resolved.python)

  const home = await mkdtemp(join(tmpdir(), 'mcl-backfill-home-'))
  const v3Root = join(home, '.memory-context-lab', 'v3')
  let ctx = null
  let session = null
  try {
    // 1) 预置历史记录（模拟 T2 启用前已落库的部分）。
    await mkdir(join(v3Root, 'sessions'), { recursive: true })
    const { port, store } = await createSessionStorePort(v3Root, SESSION_KEY)
    const records = []
    for (let index = 1; index <= SEED_TEXT; index += 1) {
      records.push(recordOf(index, '回填冒烟记录 ' + index + '：蓝鲸协议 alpha-' + (7000 + index) + ' 的正文'))
    }
    for (let index = SEED_TEXT + 1; index <= SEED_TEXT + SEED_META; index += 1) {
      records.push(recordOf(index, '', { metaOnly: true }))
    }
    const txn = await port.transaction(records)
    const directory = port.directory
    store.close()
    log('预置记录 ' + txn.recordIds.length + ' 条（可镜像 ' + SEED_TEXT + ' / metadata-only ' + SEED_META + '）')

    // 2) 真实入口 apply（临时 DSH_HOME；T2 走已解析的包根）。
    process.env.DSH_HOME = home
    process.env.MEMORY_LAB_T2_REPO = resolved.repoRoot
    const module = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.mjs')).href)
    ctx = stubContext()
    session = fakeSession()
    await module.apply(ctx, {})
    const enabled = await invoke(ctx, session, 'on')
    if (enabled.kind !== 'success') return fail('on 命令失败：' + enabled.text)
    await ctx._preStep({ agent: { session }, signal: undefined })

    // 3) 显式回填 20 条。
    const started = await invoke(ctx, session, 't2 backfill ' + LIMIT)
    log('backfill 回执：' + started.text.replace(/\n/g, ' | '))
    if (started.kind !== 'success' || !started.text.includes('已开始回填')) return fail('回填命令没有立即返回计划量')

    const state = await waitForState(directory)
    if (state === null) return fail('回填超时（状态文件未落定）')
    if (state.status !== 'done') return fail('回填未完成：' + JSON.stringify(state))
    const t2Root = join(directory, 't2-mdcg')
    let nodes = await scanMirroredNodes(t2Root)
    log('回填后节点：mirrored=' + nodes.mirrored + ' files=' + nodes.files + ' smoke=' + nodes.smoke)
    if (nodes.mirrored !== LIMIT) return fail('期望镜像 ' + LIMIT + ' 条，实际 ' + nodes.mirrored)

    // 4) 再跑 20 条：只镜像**尚未镜像**的下一批，ID 不得重复。
    const second = await invoke(ctx, session, 't2 backfill ' + LIMIT)
    log('第二批回执：' + second.text.replace(/\n/g, ' | '))
    const secondState = await waitForState(directory)
    if (secondState === null || secondState.status !== 'done') return fail('第二批回填未完成')
    nodes = await scanMirroredNodes(t2Root)
    log('两批后节点：mirrored=' + nodes.mirrored + ' files=' + nodes.files)
    if (nodes.mirrored !== LIMIT * 2) return fail('两批应镜像 ' + (LIMIT * 2) + ' 条，实际 ' + nodes.mirrored)

    // 5) 收口：把剩余 40 条也回填，确认全部可镜像记录都已镜像。
    const finish = await invoke(ctx, session, 't2 backfill 100')
    log('收口回执：' + finish.text.replace(/\n/g, ' | '))
    const finishState = await waitForState(directory)
    if (finishState === null || finishState.status !== 'done') return fail('收口回填未完成')
    nodes = await scanMirroredNodes(t2Root)
    if (nodes.mirrored !== SEED_TEXT) return fail('收口后应有 ' + SEED_TEXT + ' 条镜像，实际 ' + nodes.mirrored)

    // 6) 幂等重跑：计划 0，节点不增。
    const again = await invoke(ctx, session, 't2 backfill ' + LIMIT)
    log('重复回执：' + again.text.replace(/\n/g, ' | '))
    if (!again.text.includes('没有需要回填')) return fail('重复执行未被判为无需回填')
    nodes = await scanMirroredNodes(t2Root)
    if (nodes.mirrored !== SEED_TEXT) return fail('重复执行改变了节点数：' + nodes.mirrored)

    // 7) 覆盖率诊断：可镜像 60 / 已镜像 60（冒烟节点排除）。
    const diag = await invoke(ctx, session, 't2')
    log('t2 诊断：' + diag.text.replace(/\n/g, ' | '))
    if (!/可镜像 60 条/.test(diag.text)) return fail('诊断没有给出可镜像 60 条')
    if (!/已镜像 60 条/.test(diag.text)) return fail('诊断没有给出已镜像 60 条')
    if (!/100\.0%/.test(diag.text)) return fail('诊断没有给出 100% 覆盖率')
    if (!/冒烟节点 mcl-smoke/.test(diag.text)) return fail('诊断必须说明冒烟节点已排除')

    // 6) 独立 MCP 客户端确认回填节点可检索（不依赖插件进程内 provider）。
    const described = await probeT2Isolated({
      root: t2Root,
      repoRoot: resolved.repoRoot,
      python: resolved.python,
      version: resolved.version,
      timeoutMs: 60000,
    })
    if (described.smokePassed !== true) return fail('回填后独立 MCP 握手/冒烟失败：' + JSON.stringify(described.error))
    try {
      const read = await described.handle.callTool('cg', {
        op: 'read',
        query: '蓝鲸协议 alpha-7001',
        session: SESSION_KEY,
        limit: 10,
      }, { timeoutMs: 20000 })
      const ids = (Array.isArray(read?.results) ? read.results : []).map((row) => row?.node?.id ?? row?.id)
      log('隔离根检索命中：' + JSON.stringify(ids.slice(0, 5)))
      if (!ids.includes('v3r-' + (1).toString(16).padStart(16, '0'))) return fail('回填节点在隔离根检索不到')
    } finally {
      try { await described.handle.close() } catch {}
    }

    log('通过：命令面回填 20 条、幂等、覆盖率与隔离检索均正常。')
    return 0
  } finally {
    try { ctx?._dispose() } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('[t2-backfill-smoke] 未捕获异常：' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 1
})
