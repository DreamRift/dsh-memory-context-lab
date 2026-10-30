/**
 * AUD50-03-01（B2-4）：打开期对账与在飞提交的竞态。
 *
 * 修前：openV3SessionStore 在锁外读日志、判 damaged、隔离残留。第二句柄在写入者
 * 「payload 已写、commit 未落」的窗口打开，会把在飞 payload 当崩溃残留隔离；
 * 写入者随后提交 → 「有 commit 无 payload」账实不符 → 之后每次打开都 damaged，
 * 永久拒写（S1b）。修法：对账整段进跨进程写锁，锁内重读；锁被活写者持有时
 * 有上限等待（ELOCKED 失败关闭），不立即判 damaged；同进程重入不死锁。
 *
 * 本套件用真实子进程：子进程先取跨进程写锁、写 payload、暂停在提交窗口里，
 * 再补 commit 并释放——覆盖「锁忙」「不隔离在飞记录」「提交后 healthy」三个判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { withCrossProcessWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'

const SRC = path.resolve(fileURLToPath(new URL('../src/v3/adapters/storage/', import.meta.url)))

const CHILD_SCRIPT = [
  "const { acquireWriteLock } = await import(process.env.CHILD_LOCK)",
  "const { writeFileAtomic } = await import(process.env.CHILD_STORE)",
  "import { appendFile, readFile } from 'node:fs/promises'",
  "import path from 'node:path'",
  "const [op, root, key, holdMs] = [process.env.CHILD_OP, process.env.CHILD_ROOT, process.env.CHILD_KEY, process.env.CHILD_HOLD]",
  "const dir = path.join(root, 'sessions', key)",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))",
  "const say = (obj) => process.stdout.write(JSON.stringify(obj) + String.fromCharCode(10))",
  "if (op === 'inflight') {",
  "  const lock = await acquireWriteLock(dir)",
  "  say({ event: 'locked' })",
  "  const id = 'v3r-' + 'ab'.repeat(8)",
  "  const text = 'inflight-payload'",
  "  const record = { id, kind: 'message-user', sessionKey: key, createdAt: 1, payload: { text, bytes: Buffer.byteLength(text, 'utf8') }, provenance: { sourceEventId: 'evt-1', sourceForm: 'live', transactionId: 'tx-child-1' } }",
  "  await writeFileAtomic(path.join(dir, 'records', id + '.json'), JSON.stringify(record) + String.fromCharCode(10))",
  "  say({ event: 'payload-written', id })",
  "  await sleep(Number(holdMs))",
  "  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))",
  "  await appendFile(path.join(dir, 'transactions.jsonl'), JSON.stringify({ action: 'commit', txn: manifest.txnNext, recordIds: [id], at: 1 }) + String.fromCharCode(10))",
  "  await writeFileAtomic(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, txnNext: manifest.txnNext + 1 }) + String.fromCharCode(10))",
  "  await lock.release()",
  "  say({ event: 'done', txn: manifest.txnNext })",
  "}",
].join(String.fromCharCode(10))

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-open-race-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnChild(root, key, holdMs) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    env: {
      ...process.env,
      CHILD_LOCK: pathToFileURL(path.join(SRC, 'write-lock.mjs')).href,
      CHILD_STORE: pathToFileURL(path.join(SRC, 'session-store.mjs')).href,
      CHILD_OP: 'inflight',
      CHILD_ROOT: root,
      CHILD_KEY: key,
      CHILD_HOLD: String(holdMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf(String.fromCharCode(10))
    while (index >= 0) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (raw.trim().length > 0) lines.push(JSON.parse(raw))
      index = buffer.indexOf(String.fromCharCode(10))
    }
  })
  child.stderr.on('data', (chunk) => lines.push({ event: 'child-error', text: chunk.toString('utf8') }))
  const waitFor = (event, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const hit = lines.find((line) => line.event === event)
      if (hit !== undefined) { clearInterval(timer); resolve(hit) }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('子进程未回报 ' + event + '：' + JSON.stringify(lines))) }
    }, 25)
  })
  return { child, waitFor, lines }
}

test('B2-4 在飞提交窗口打开：不隔离在飞 payload、不判 damaged（锁忙等待后 ELOCKED）', async () => {
  await withRoot(async (root) => {
    const pre = await openV3SessionStore(root, 's-race')
    pre.close()
    const proc = spawnChild(root, 's-race', 1200)
    try {
      await proc.waitFor('payload-written')
      // 窗口内打开：锁被活写者持有 → 有上限等待 → ELOCKED（绝不立即判 damaged）
      await assert.rejects(
        openV3SessionStore(root, 's-race', { lock: { waitMs: 250 } }),
        (error) => error.code === 'ELOCKED',
      )
      const recordsDir = path.join(root, 'sessions', 's-race', 'records')
      assert.equal((await readdir(recordsDir)).filter((n) => n.endsWith('.json')).length, 1, '在飞 payload 未被隔离')
      // 写入者提交并释放锁后：打开 healthy，记录可读，无隔离残留
      const done = await proc.waitFor('done')
      assert.equal(done.txn, 1, '子进程按 manifest.txnNext 提交')
      const store = await openV3SessionStore(root, 's-race')
      const health = store.health()
      assert.equal(health.healthy, true, JSON.stringify(health))
      assert.equal(health.recordCount, 1)
      const record = await store.readRecord('v3r-' + 'ab'.repeat(8))
      assert.equal(record.payload.text, 'inflight-payload')
      const quarantine = await readdir(path.join(root, 'sessions', 's-race', 'quarantine'))
      assert.deepEqual(quarantine, [], '已提交记录不得进 quarantine')
      store.close()
    } finally {
      proc.child.kill()
    }
  })
})

test('B2-4 锁重入：同进程已持锁时再 open 不死锁（AsyncLocalStorage 重入）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'sessions', 's-reentry')
    const started = Date.now()
    const store = await Promise.race([
      withCrossProcessWriteLock(dir, () => openV3SessionStore(root, 's-reentry')),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
    assert.ok(store !== null, '5s 内未完成 = 死锁（重入失效）')
    assert.ok(Date.now() - started < 5000)
    store.close()
  })
})
