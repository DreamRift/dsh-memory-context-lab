/**
 * 子进程锁探针：只在测试里用，验证跨进程独占与释放后接管。
 * 用法：node lock-child.mjs <sessionDir> <holdMs>
 * 退出码：0 = 拿到锁并正常释放；3 = ELOCKED；其它 = 意外错误。
 */
import { acquireWriteLock } from '../../src/v2/write-lock.mjs'

const directory = process.argv[2]
const holdMs = Number(process.argv[3] ?? '500')
try {
  const handle = await acquireWriteLock(directory, { waitMs: 0 })
  process.stdout.write('ACQUIRED' + String.fromCharCode(10))
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  await handle.release()
  process.exit(0)
} catch (error) {
  process.stdout.write('ERROR:' + (error?.code ?? 'unknown') + String.fromCharCode(10))
  process.exit(error?.code === 'ELOCKED' ? 3 : 4)
}
