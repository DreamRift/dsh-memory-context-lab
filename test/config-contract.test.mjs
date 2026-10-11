// Host Config protocol contract: the desktop settings page only serves a
// plugin namespace when the exported schema's volatile leaf fields
// (defaults/presets here) arrive as cosmokit volatile refs — never as inline
// values. This test emulates the host's resolveConfig + volatileForm pass.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/index.mjs'
import * as kit from '@deepseek-ai/cosmokit'

test('Config exposes the standard-schema interface the host requires', () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
})

test('fresh install resolves defaults/presets as volatile refs', () => {
  const resolved = Config['~standard'].validate({})
  assert.equal(resolved.issues, undefined)
  for (const key of ['defaults', 'presets']) {
    const raw = resolved.value?.[key]
    assert.ok(raw && typeof raw === 'object' && typeof raw.get === 'function', `${key} is a volatile ref`)
    assert.equal(kit.isVolatile(raw), true, `${key} recognized by cosmokit.isVolatile`)
  }
  const defaults = resolved.value.defaults.get()
  assert.equal(defaults?.retainOperations, 5)
  assert.equal(defaults?.auto, true)
  const presets = resolved.value.presets.get()
  assert.ok(Array.isArray(presets) && presets.length > 0)
  assert.equal(typeof presets[0]?.name, 'string')
})

test('volatile wrapping preserves the standard-schema protocol', () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
})

test('explicit user config passes through as volatile refs with user values', () => {
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
