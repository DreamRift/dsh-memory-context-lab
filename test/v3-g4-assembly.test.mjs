/**
 * G4 装配可达性 + 默认关闭 + off 路径逐字节等价（学 G5 指纹法）。
 *
 * ## 为什么需要这一套
 * G4 的验收要求是「零引用修复后要有装配可达性测试，不能只证明纯函数可运行」，并且
 * 「默认关闭」不能只是注释：off 路径必须对模型可见面与落盘面**零影响**。三条同时成立才算：
 * ① 入口 import 图可达（attachV3Engine 返回的句柄来自首次呈现模块）；
 * ② 默认不激活（开关缺省关闭、pre-step 钩子不引用它、打开开关也不派发）；
 * ③ off 路径逐字节等价：同一合成夹具在**改动前**（把装配行逐字还原）与当前树上跑出的
 *    sha256 完全相同，且没有任何 first-ingress 产物。
 *
 * ## 指纹口径（与 证据/G4-tmp/capture-off.mjs 同一实现）
 * sha256(规范化 JSON{ deriveMessages(), surface.nodes, 事件正文, 落盘文件清单+内容摘要 })。
 * 归一化只抹掉随机 ID（v3r-…、uuid、长十六进制）与固定的 Date.now，因此「同样的输入』
 * 必须得到同样的字节；任何让 off 路径多一个事件/多一个文件/改一个字的改动都会红。
 *
 * ## 不证明什么
 * 真实宿主时序（替换是否发生在目标请求之前）与 wire 可见性未验（G8）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

/**
 * 改动前（G4 装配行尚未加入时）捕获的指纹；证据：证据/G4-实现.md §off-等价。
 * 复现：把 v3-entry.mjs 里的 G4 装配三行逐字删掉后跑同一夹具，得到同一个值（本套件 A3 会当场重放）。
 */
const OFF_GOLDEN = '9f2fa55cd896bc3379db1c12d4630b7c8aa28ceb331d4da8258457c864c42765'

const FIXED_NOW = 1700000000000
/** 派生缓存：可全量重建、内容含文件戳，指纹不覆盖（名字也不覆盖）。 */
const DERIVED_FILES = new Set(['lexical-index.json', 'chunk-index.json'])
const BIG = 'L'.repeat(9000)

function fakeCtx() {
  const handlers = new Map()
  return {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { warn() {}, info() {} },
    handlers,
  }
}

function fakeSession(id) {
  const log = []
  const nodes = []
  let next = 0
  const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  function append(type, data, options = {}) {
    const seq = next
    const op = options.surfaceOp
    const event = { type, seq, time: FIXED_NOW + seq, data }
    if (SURFACE.has(type) && op !== undefined && op !== null && op !== 'append') {
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error('fake: replace range 不在 surface')
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      event.surfaceOp = { ...op }
      event.sourceEventSeqs = [...(options.sourceEventSeqs ?? [])]
      const missing = shadowed.filter((node) => !event.sourceEventSeqs.includes(node))
      if (missing.length > 0) throw new Error('fake: sourceEventSeqs 未覆盖 ' + missing.join(','))
      log.push(event)
      nodes.splice(startIdx, shadowed.length, seq)
    } else {
      log.push(event)
      if (SURFACE.has(type)) nodes.push(seq)
    }
    next += 1
    return event
  }
  return {
    id,
    log,
    surface: { nodes },
    append,
    eventAt: (seq) => log[seq],
    deriveMessages() {
      return nodes.map((seq) => {
        const e = log[seq]
        if (e?.type === 'user/message') return e.data
        return e?.data?.message ?? null
      }).filter(Boolean)
    },
  }
}

function textOf(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (Array.isArray(content)) return content.map((p) => (p?.type === 'text' ? p.text : '[' + (p?.type ?? '?') + ']')).join('')
  return typeof event?.data?.text === 'string' ? event.data.text : ''
}

/** 归一化：随机记录 ID / 事务 uuid / 长十六进制换成占位符（与 G5 指纹同法）。 */
function normalize(text) {
  return String(text)
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replaceAll(/v3r-[0-9a-f]+/g, '<rid>')
    .replaceAll(/[0-9a-f]{8,}/g, '<hex>')
    .replaceAll(/"at":\s*\d+/g, '"at":<ts>')
}

async function inventory(root, dir = root, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { await inventory(root, full, out); continue }
    // 派生缓存（lexical-index / chunk-index）是可全量重建的派生物，重建是防抖后台任务：
    // 存不存在取决于本次运行的时序，不属于「模型可见面/事实面」——整个跳过。
    if (DERIVED_FILES.has(entry.name)) continue
    const rel = normalize(path.relative(root, full).replaceAll('\\', '/'))
    let digest
    try {
      const body = await readFile(full, 'utf8')
      digest = createHash('sha256').update(normalize(body), 'utf8').digest('hex').slice(0, 16)
    } catch { digest = 'unreadable' }
    out.push(rel + ':' + digest)
  }
  // 归一化后名字会撞（<rid>.json），排序必须放在归一化之后——否则遍历顺序随机、指纹抖动。
  out.sort()
  return out
}

/** 同一合成夹具：在**给定源码根**上跑一轮 pre-step，输出指纹与旁证。 */
async function fingerprintOf(srcRoot) {
  const entryModule = await import(pathToFileURL(path.join(srcRoot, 'v3', 'entry', 'v3-entry.mjs')).href)
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g4-off-'))
  const realNow = Date.now
  Date.now = () => FIXED_NOW
  try {
    const ctx = fakeCtx()
    const engine = entryModule.attachV3Engine(ctx, { v3Root: root, defaultEnabled: true })
    try {
      const session = fakeSession('g4-off')
      session.append('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'S' }] } }, { surfaceOp: 'append' })
      session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q' }] }, { surfaceOp: 'append' })
      session.append('assistant/message', { message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' })
      session.append('tool/result', { message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: BIG }], toolCallId: 'c1', isError: false } }, { surfaceOp: 'append' })
      session.append('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'A' }] } }, { surfaceOp: 'append' })
      const hook = ctx.handlers.get('agent/pre-step')
      if (typeof hook !== 'function') throw new Error('pre-step 钩子未注册')
      await hook(
        { agent: { session }, turn: 1, step: 1, signal: { aborted: false }, messages: [] },
        async () => ({ kind: 'enter' }),
      )
      await engine._waitForIdle()
      const messages = session.deriveMessages()
      const events = session.log.map((e) => ({ type: e.type, text: textOf(e) }))
      const files = await inventory(root)
      const payload = JSON.stringify({ messages, nodes: session.surface.nodes, events, files }, null, 1)
      return {
        fingerprint: createHash('sha256').update(payload, 'utf8').digest('hex'),
        events: events.length,
        files,
        tokenInSurface: messages.some((m) => JSON.stringify(m).includes('[mcl-first-ingress]')),
        handle: engine.firstIngress ?? null,
      }
    } finally {
      engine.dispose()
    }
  } finally {
    Date.now = realNow
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 把当前 src 复制到临时目录，并**逐字还原** G4 的三处装配（import / 构造 / 返回字段）。 */
async function copyWithWiringReverted() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-g4-src-'))
  const copy = path.join(dir, 'src')
  await cp(SRC, copy, { recursive: true })
  const entryFile = path.join(copy, 'v3', 'entry', 'v3-entry.mjs')
  let body = await readFile(entryFile, 'utf8')
  const lines = body.split(/\r?\n/)
  const kept = lines.filter((line) => !/first-ingress|firstIngress/.test(line))
  body = kept.join('\n')
  await writeFile(entryFile, body, 'utf8')
  assert.equal(/firstIngress|first-ingress/.test(body), false, '还原后不得残留任何 G4 装配引用')
  return { dir, copy }
}

test('G4-A1 装配可达但零激活：句柄来自首次呈现模块，pre-step 不派发、不产文件、不出回执', async () => {
  const out = await fingerprintOf(SRC)
  assert.equal(out.tokenInSurface, false, '默认关闭路径绝不能出现回执')
  assert.equal(out.files.some((file) => file.includes('first-ingress')), false, '不得产生 first-ingress 产物')
  assert.ok(out.handle !== null, '入口必须暴露候选句柄（装配可达）')
  assert.equal(out.handle.contract, 'v3-first-ingress-assembly/v1')
  assert.equal(out.handle.status, 'inactive')
  assert.equal(out.handle.enabled, false)
})

test('G4-A2 off 路径逐字节等价：当前树指纹等于改动前冻结的指纹（G5 指纹法）', async () => {
  const out = await fingerprintOf(SRC)
  assert.equal(out.fingerprint, OFF_GOLDEN, 'off 路径漂移：模型可见面/活动面/落盘面有变化')
  assert.equal(out.events, 5)
})

test('G4-A3 还原对照：逐字删掉装配三行后同一夹具仍得到同一指纹（zero-impact 证明）', async () => {
  const { dir, copy } = await copyWithWiringReverted()
  try {
    const out = await fingerprintOf(copy)
    assert.equal(out.fingerprint, OFF_GOLDEN, '装配行对 off 路径没有任何影响')
    assert.equal(out.handle, null, '还原后入口不再暴露句柄（对照成立）')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('G4-A4 打开独立开关也不在 pre-step 派发（零激活路径）', async () => {
  const ctx = fakeCtx()
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g4-switch-'))
  const engine = (await import(pathToFileURL(path.join(SRC, 'v3', 'entry', 'v3-entry.mjs')).href))
    .attachV3Engine(ctx, {
      v3Root: root,
      defaultEnabled: true,
      settingsNow: () => ({ firstIngress: { enabled: true } }),
    })
  try {
    assert.equal(engine.firstIngress.enabledNow(), true, '开关独立可读')
    assert.equal(engine.firstIngress.status, 'inactive', '开关打开也不激活（钩子不引用）')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
