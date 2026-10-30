/**
 * B3-7（AUD50-03-06）凭证追加进写锁——appendVoucher / markVoucherRedacted 与其它写原语
 * 共用同一把跨进程写锁；两进程并发无半行、无丢失；锁被持有时等待而非并发提交。
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
  "  if (process.env.CHILD_OP === 'voucher') {",
  "    const result = await port.appendVoucher({ recordIds: [], targetEventId: 'evt-' + process.env.CHILD_TAG, receiptText: '回执', txn: 1 })",
  "    process.stdout.write(JSON.stringify(result) + String.fromCharCode(10))",
  "  } else {",
  "    const result = await port.markVoucherRedacted('v-' + process.env.CHILD_TAG, true)",
  "    process.stdout.write(JSON.stringify(result) + String.fromCharCode(10))",
  "  }",
  "  port.close()",
  "}"
].join(String.fromCharCode(10))

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-voucher-lock-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnChild(root, key, op, tag) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, CHILD_PORT: PORT_URL, CHILD_LOCK: LOCK_URL, CHILD_OP: op, CHILD_ROOT: root, CHILD_KEY: key, CHILD_TAG: tag },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('child ' + tag + ' 退出 ' + code + '：' + err.slice(0, 600)))
      else resolve(JSON.parse(out.trim().split('\n').pop()))
    })
  })
}

async function voucherLineCount(root, key) {
  const text = await readFile(path.join(root, 'sessions', key, 'vouchers.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line.trim().length > 0);
}

test('B3-7 两个子进程并发追加凭证：两行完整、重开可读', async () => {
  await withRoot(async (root) => {
    await Promise.all([spawnChild(root, 's-v', 'voucher', 'a'), spawnChild(root, 's-v', 'voucher', 'b')])
    const lines = await voucherLineCount(root, 's-v')
    assert.equal(lines.length, 2, '两行都在（无丢失）')
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), '无半行')
    const store = await openV3SessionStore(root, 's-v')
    try {
      assert.equal(store.health().voucherCount, 2)
      assert.equal(store.health().healthy, true)
    } finally {
      store.close()
    }
  })
})

test('B3-7 凭证追加尊重写锁：锁被持有时等待', async () => {
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
        await until('locked')
        const started = Date.now()
        await port.appendVoucher({ recordIds: [], targetEventId: 'evt-w', receiptText: '回执', txn: 1 })
        const elapsed = Date.now() - started
        assert.ok(elapsed >= 700, '凭证追加必须等持锁者释放（实测 ' + elapsed + 'ms）')
        await until('released')
      } finally {
        port.close()
      }
    } finally {
      child.kill()
    }
  })
})

test('B3-7 markVoucherRedacted 同锁：等待且正常标记', async () => {
  await withRoot(async (root) => {
    const { port } = await createSessionStorePort(root, 's-mark')
    try {
      await port.appendVoucher({ recordIds: [], targetEventId: 'evt-m', receiptText: '回执', txn: 1 })
      const marked = await port.markVoucherRedacted('v-1', true)
      assert.equal(marked.changed, true)
      assert.deepEqual(port.redactedVoucherIds(), ['v-1'])
      const again = await port.markVoucherRedacted('v-1', true)
      assert.equal(again.changed, false, '幂等不重复追加')
    } finally {
      port.close()
    }
  })
})
