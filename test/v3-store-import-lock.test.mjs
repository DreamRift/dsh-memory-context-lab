/**
 * AUD50-03-02（B2-5）：importRecords 绕过写锁。
 *
 * 修前：端口层 importRecords 直接调 store.importRecords，不取跨进程写锁——
 * 两个句柄并发 import 实测 txnA=txnB=1、commit 行 [1,1]、唯一事务号 1（应为 2）。
 * 修法：与 transaction/forget/revokeForget 共用同一把跨进程写锁，锁内先
 * syncFromLog（事务号基于最新日志分配）；索引重建留在锁外。
 * 本套件用真实子进程并发导入，验证事务号唯一性与账实一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const STORAGE_DIR = path.resolve(fileURLToPath(new URL('../src/v3/adapters/storage/', import.meta.url)))
const PORT_URL = pathToFileURL(path.join(STORAGE_DIR, 'session-store-port.mjs')).href
const LOCK_URL = pathToFileURL(path.join(STORAGE_DIR, 'write-lock.mjs')).href

const CHILD_SCRIPT = [
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))",
  "if (process.env.CHILD_OP === 'hold') {",
  "  const { acquireWriteLock } = await import(process.env.CHILD_LOCK)",
  "  const path = await import('node:path')",
  "  const lock = await acquireWriteLock(path.join(process.env.CHILD_ROOT, 'sessions', process.env.CHILD_KEY))",
  "  process.stdout.write(JSON.stringify({ event: 'locked' }) + String.fromCharCode(10))",
  "  await sleep(Number(process.env.CHILD_HOLD))",
  "  await lock.release()",
  "  process.stdout.write(JSON.stringify({ event: 'released' }) + String.fromCharCode(10))",
  "} else {",
  "  const { createSessionStorePort } = await import(process.env.CHILD_PORT)",
  "  const { port } = await createSessionStorePort(process.env.CHILD_ROOT, process.env.CHILD_KEY)",
  "  const count = Number(process.env.CHILD_COUNT)",
  "  const records = Array.from({ length: count }, (_, i) => ({ kind: 'message-user', payload: { text: process.env.CHILD_TAG + '-' + i } }))",
  "  const result = await port.importRecords(records)",
  "  process.stdout.write(JSON.stringify({ txn: result.txn }) + String.fromCharCode(10))",
  "  port.close()",
  "}",
].join(String.fromCharCode(10))

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-import-lock-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnImporter(root, key, tag, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
      env: { ...process.env, CHILD_PORT: PORT_URL, CHILD_LOCK: LOCK_URL, CHILD_OP: "import", CHILD_ROOT: root, CHILD_KEY: key, CHILD_TAG: tag, CHILD_COUNT: String(count) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => { out += c.toString("utf8") })
    child.stderr.on("data", (c) => { err += c.toString("utf8") })
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error("importer " + tag + " 退出 " + code + "：" + err.slice(0, 600)))
      else resolve(JSON.parse(out.trim().split("\n").pop()))
    })
  })
}

async function commitTxnsOf(root, key) {
  const text = await readFile(path.join(root, "sessions", key, "transactions.jsonl"), "utf8")
  return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line)).filter((line) => line.action === "commit").map((line) => line.txn)
}

test('B2-5 两个子进程并发导入：事务号唯一、账实一致', async () => {
  await withRoot(async (root) => {
    const results = await Promise.all([
      spawnImporter(root, 's-imp', 'a', 10),
      spawnImporter(root, 's-imp', 'b', 10),
    ])
    const txns = results.map((r) => r.txn)
    assert.equal(new Set(txns).size, 2, "事务号必须唯一（修前两把都拿到 1）：" + JSON.stringify(txns))
    const store = await openV3SessionStore(root, 's-imp')
    try {
      const health = store.health()
      assert.equal(health.healthy, true, JSON.stringify(health))
      assert.equal(health.recordCount, 20)
      const commits = await commitTxnsOf(root, "s-imp")
      assert.equal(commits.length, 2, "两次导入各一笔事务")
      assert.equal(new Set(commits).size, 2, "commit 行事务号唯一")
      assert.equal(health.txnNext, Math.max(...commits) + 1, "manifest 自愈到 maxTxn+1")
    } finally {
      store.close()
    }
  })
})

test('B2-5 导入与常规事务并发：无重复事务号、无丢失记录', async () => {
  await withRoot(async (root) => {
    const { port } = await createSessionStorePort(root, 's-mix')
    try {
      const importer = spawnImporter(root, "s-mix", "c", 10)
      const localTxn = await port.transaction([
        { id: "v3r-" + "cd".repeat(8), kind: "message-user", sessionKey: "s-mix", createdAt: 1, payload: { text: "本地事务", bytes: 12 }, provenance: { sourceEventId: "evt-local", sourceForm: "live", transactionId: "tx-local" } },
      ])
      const remote = await importer
      const commits = await commitTxnsOf(root, "s-mix")
      assert.equal(commits.length, 2)
      assert.equal(new Set(commits).size, 2, "并发写入事务号唯一")
      assert.deepEqual(new Set(commits), new Set([localTxn.txn, remote.txn]), "commit 行与两个返回值一致")
      // port.health 是进程内视图（另一进程的提交未必已并入）；账实一致的权威口径是重开
      const fresh = await openV3SessionStore(root, 's-mix')
      // 权威口径是重开对账：另一进程的提交不保证已并入本句柄的进程内视图
      assert.equal(fresh.health().recordCount, 11, "无丢失记录（重开对账）")
      fresh.close()
    } finally {
      port.close()
    }
  })
})

test('B2-5 导入尊重写锁：锁被持有时等待，不并发提交', async () => {
  await withRoot(async (root) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, CHILD_PORT: PORT_URL, CHILD_LOCK: LOCK_URL, CHILD_OP: 'hold', CHILD_ROOT: root, CHILD_KEY: 's-hold', CHILD_HOLD: '800' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    const until = (event) => new Promise((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (out.includes(event)) { clearInterval(timer); resolve() }
        else if (Date.now() - started > 8000) { clearInterval(timer); reject(new Error('子进程未回报 ' + event)) }
      }, 20)
    })
    try {
      const { port } = await createSessionStorePort(root, 's-hold')
      try {
        // 等子进程持锁后再发起导入
        await until('locked')
        const started = Date.now()
        await port.importRecords(Array.from({ length: 5 }, (_, i) => ({ kind: 'message-user', payload: { text: 'waited-' + i } })))
        const elapsed = Date.now() - started
        assert.ok(elapsed >= 700, '导入必须等持锁者释放（实测 ' + elapsed + 'ms；修前 ~50ms 内并发提交）')
        await until('released')
      } finally {
        port.close()
      }
    } finally {
      child.kill()
    }
  })
})

test('B2-5 导入失败：整批不提交、不消耗事务号', async () => {
  await withRoot(async (root) => {
    const { port } = await createSessionStorePort(root, 's-fail')
    try {
      await assert.rejects(
        port.importRecords([{ kind: "message-user" }]),
        /payload.text/,
      )
      const health = await port.health()
      assert.equal(health.txnNext, 1, "失败不烧号")
      const result = await port.importRecords([{ kind: "message-user", payload: { text: "成功导入" } }])
      assert.equal(result.txn, 1, "下一笔导入拿到的就是 1 号")
    } finally {
      port.close()
    }
  })
})
