#!/usr/bin/env node
/**
 * 真实灵枢（md_cg）健康探针：只做诊断，不启动常驻服务、不读写正式根。
 *
 * 用途：把「包在但 Python 包坏了」和「插件参数/契约回归」分开。集成测试里
 * 真正的写入探针会给出可执行的环境原因；本脚本用于人工排查。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { locatePinnedDshMemory } from '../src/dsh-memory-suppression.mjs'

const requireFromPlugin = createRequire(import.meta.url)

function runPython(code, env) {
  return new Promise((resolve) => {
    const child = spawn('python', ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error) }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
  })
}

let located
try {
  located = await locatePinnedDshMemory(requireFromPlugin)
} catch (error) {
  console.error(`未定位到 @furongjun1999/dsh-memory：${error?.message ?? error}`)
  process.exit(1)
}
console.log(`packageRoot: ${located.packageRoot}`)
console.log(`version:     ${located.version}`)
const env = { ...process.env, PYTHONPATH: located.packageRoot }
const imported = await runPython('import md_cg.mcp_server; print("mcp ok")', env)
console.log(`import md_cg.mcp_server: ${imported.ok ? 'ok' : 'FAIL'}`)
if (!imported.ok) {
  console.error(imported.stderr.trim().split(/\r?\n/).slice(-3).join('\n'))
  process.exit(1)
}
const fsutil = await runPython('import md_cg.fsutil as f; print("node_write_lock" in dir(f))', env)
const hasLock = fsutil.ok && fsutil.stdout.trim() === 'True'
console.log(`md_cg.fsutil.node_write_lock: ${hasLock ? 'present' : 'MISSING'}`)
if (!hasLock) {
  console.error('WARN：md_cg 可导入但写入路径可能失败（mdcg_remember 需要 node_write_lock）。请修复或重装 dsh-memory 后再跑真实集成。')
  process.exit(1)
}
console.log('探针通过；真实写入仍需集成用例（v2-lingshu-integration）验证。')
