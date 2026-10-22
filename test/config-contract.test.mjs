// Host Config protocol contract: the desktop settings page only serves a
// plugin namespace when the exported schema's volatile leaf fields
// (defaults/presets here) arrive as cosmokit volatile refs — never as inline
// values. This test emulates the host's resolveConfig + volatileForm pass.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/index.mjs'
import { DEFAULT_SETTINGS } from '../src/core.mjs'

// Building Config needs BOTH optional peers: schemastery provides the schema
// factory and cosmokit the volatile-reference protocol. When either is missing
// the settings-page contract cannot be exercised here, so the suite names the
// absent package and skips instead of dying with an ERR_MODULE_NOT_FOUND that
// reads like a defect in the plugin.
let kit = null
try {
  kit = await import('@deepseek-ai/cosmokit')
} catch {
  kit = null
}
const missingPeers = []
if (kit === null) missingPeers.push('@deepseek-ai/cosmokit')
if (!Config) missingPeers.push('@deepseek-ai/schemastery')
const skipReason = missingPeers.length
  ? `未安装 ${missingPeers.join(' 与 ')}（在仓库根运行 npm install 后重跑）`
  : false
if (skipReason) console.error(`config-contract: 跳过全部断言 — ${skipReason}`)

test('Config exposes the standard-schema interface the host requires', { skip: skipReason }, () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
})

test('fresh install resolves defaults as a volatile ref', { skip: skipReason }, () => {
  const resolved = Config['~standard'].validate({})
  assert.equal(resolved.issues, undefined)
  // 0.13.1 删除了 presets：预设是 v1 的概念，全历史模式下「保留最近操作」失效，
  // 预设行没有可切换的内容。defaults 仍是 volatile 引用。
  const raw = resolved.value?.defaults
  assert.ok(raw && typeof raw === 'object' && typeof raw.get === 'function', 'defaults is a volatile ref')
  assert.equal(kit.isVolatile(raw), true, 'defaults recognized by cosmokit.isVolatile')
  assert.equal(resolved.value?.presets, undefined, '0.13.1 不再提供 presets')
  const defaults = resolved.value.defaults.get()
  assert.equal(defaults?.auto, true)
  // 0.13.1（报告 C）：闸门阈值必须出现在 schema 的 defaults 里，否则设置页
  // 根本没有第二个入口，而唯一的入口（会话面板）当时正坏着。
  assert.equal(
    defaults?.pressureGate,
    DEFAULT_SETTINGS.pressureGate,
    'defaults.pressureGate 必须与 core 的默认值同源',
  )
})


test('压力闸门阈值：schema 接受 0..95 并拒绝越界', { skip: skipReason }, () => {
  const inside = Config['~standard'].validate({ defaults: { pressureGate: 95 } })
  assert.equal(inside.issues, undefined)
  assert.equal(inside.value.defaults.get().pressureGate, 95)
  const zero = Config['~standard'].validate({ defaults: { pressureGate: 0 } })
  assert.equal(zero.issues, undefined, '0 = 无压力也降温，必须合法')
  assert.equal(zero.value.defaults.get().pressureGate, 0)
  const outside = Config['~standard'].validate({ defaults: { pressureGate: 96 } })
  assert.ok(Array.isArray(outside.issues) && outside.issues.length > 0, '96 必须被拒')
})

test('volatile wrapping preserves the standard-schema protocol', { skip: skipReason }, () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
})

test('explicit user config passes through as volatile refs with user values', { skip: skipReason }, () => {
  const explicit = Config['~standard'].validate({
    defaults: { retainOperations: 9, archiveBatchSize: 3, auto: false, autoRecall: true, autoRestore: false },
  })
  assert.equal(explicit.issues, undefined)
  const raw = explicit.value?.defaults
  assert.ok(raw && typeof raw.get === 'function', 'inline defaults still arrive as a volatile ref')
  const defaults = raw.get()
  assert.equal(defaults?.retainOperations, 9)
  assert.equal(defaults?.auto, false)
})

test('retrievalBackend 枚举：默认 auto，三个合法值放行，非法值被拒', { skip: skipReason }, () => {
  const fresh = Config['~standard'].validate({})
  assert.equal(fresh.value.defaults.get()?.retrievalBackend, 'auto')

  for (const value of ['local-lexical-v1', 'lingshu-mdcg-receipt']) {
    const resolved = Config['~standard'].validate({ defaults: { retrievalBackend: value } })
    assert.equal(resolved.issues, undefined, `${value} must be accepted`)
    assert.equal(resolved.value.defaults.get()?.retrievalBackend, value)
  }

  const rejected = Config['~standard'].validate({ defaults: { retrievalBackend: 'lunar-index' } })
  assert.ok(Array.isArray(rejected.issues) && rejected.issues.length > 0, 'an unknown backend name must be rejected by the schema')
})

test('默认值单一真源：schema default、投影兜底、客户端 fallback 与 core 的 DEFAULT_SETTINGS 一致', { skip: skipReason }, async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const { DEFAULT_SETTINGS } = await import('../src/core.mjs')
  const { viewOf } = await import('../src/projection.mjs')

  // schema default：宿主设置页给新装用户的全局默认（index.mjs 引 core 常量注册）。
  const resolved = Config['~standard'].validate({})
  const defaults = resolved.value.defaults.get()
  assert.equal(defaults?.archiveBatchSize, DEFAULT_SETTINGS.archiveBatchSize,
    `schema default 必须等于 core 默认（期望 ${DEFAULT_SETTINGS.archiveBatchSize}）`)

  // 投影兜底：折叠态视图无值时的回落也走 core 默认，不再回落旧值 5。
  const view = viewOf({})
  assert.equal(view.archiveBatchSize, DEFAULT_SETTINGS.archiveBatchSize)

  // client.js 兜底：独立 bundle 无法 import core 模块，字面量由本守卫防漂移
  // （改 core 默认时忘了同步 client.js 会让设置页显示旧值）。
  const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(pluginDir, 'src', 'client.js'), 'utf8')
  // N-09 起 settingsValueOf 以 `inner` 为底复制成 `base` 再覆盖（未知字段透传），
  // 所以兜底字面量的宿主对象名可能是 inner 或 base——守卫只钉「哪个兜底值」，
  // 不钉局部变量名（钉死了就会在纯重构时假红）。
  const match = /archiveBatchSize\s*[:=]\s*clampInt\((?:inner|base)\.archiveBatchSize,\s*1,\s*200,\s*(\d+)\)/.exec(source)
  assert.ok(match, 'client.js 必须保留 archiveBatchSize 的 clampInt 兜底形态（守卫的正则与实现耦合，改动时同步）')
  assert.equal(Number(match[1]), DEFAULT_SETTINGS.archiveBatchSize,
    'client.js 兜底字面量必须与 core 的 DEFAULT_SETTINGS.archiveBatchSize 一致')
})
