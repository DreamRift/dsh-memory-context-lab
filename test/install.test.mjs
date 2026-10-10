/**
 * Installation tests: load the host half the way the profile does.
 *
 * A unit test that imports `../src/index.mjs` resolves from the workspace, where
 * nothing else lives. The host instead loads the *installed* path, and that
 * difference is exactly what broke `@furongjun1999/dsh-memory` lookup when the
 * plugin was linked into the profile: `createRequire` walked the workspace tree
 * and never saw the profile that installed the package.
 *
 * These tests therefore exercise the installed path when it exists, and verify
 * the lookup finds the real package rather than merely not throwing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { dshMemoryLookupRoots, locatePinnedDshMemory } from '../src/dsh-memory-suppression.mjs'

const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const installedEntry = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-memory-context-lab', 'src', 'index.mjs')

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** A stub context that supports both effect forms and records registrations. */
function createStubContext() {
  const listeners = new Map()
  const prependEvents = []
  const commands = []
  const projections = []
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)) },
    get(name) {
      if (name === 'tokenMeter') {
        return {
          estimateMessage: (message) => Math.ceil(JSON.stringify(message).length / 4),
          measure: () => ({ totalTokens: 0, nodes: [], baseline: { kind: 'estimated' } }),
        }
      }
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) }
      return undefined
    },
    on(event, handler, options) {
      const rows = listeners.get(event) ?? []
      if (options?.prepend) {
        rows.unshift(handler)
        prependEvents.push(event)
      } else {
        rows.push(handler)
      }
      listeners.set(event, rows)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
      }
    },
    effect(fn) {
      const local = []
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) {
          local.push(step.value)
          step = result.next()
        }
      } else if (typeof result === 'function') {
        local.push(result)
      }
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register: (definition) => { commands.push(definition); return () => {} } },
    sessionProjections: { register: (definition) => { projections.push(definition); return () => {} } },
    _listeners: listeners,
    _prependEvents: prependEvents,
    _commands: commands,
    _projections: projections,
    _warnings: warnings,
  }
  return ctx
}

test('the lookup searches the DSH home, not only this plugin\'s own tree', async () => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  const roots = await dshMemoryLookupRoots({
    requireFromPlugin,
    dshHome: 'C:/definitely-not-a-real-dsh-home',
    listProfiles: async () => [],
  })
  assert.ok(roots.length >= 1, 'at least one candidate root must be produced')
  assert.ok(roots.includes(path.resolve('C:/definitely-not-a-real-dsh-home', 'node_modules')))

  const withProfiles = await dshMemoryLookupRoots({
    requireFromPlugin,
    dshHome: 'C:/fake-home',
    listProfiles: async () => ['C:/fake-home/profiles/desktop'],
  })
  assert.ok(withProfiles.includes(path.resolve('C:/fake-home/profiles/desktop/node_modules')), 'the profile root must be searched')
  assert.equal(new Set(withProfiles).size, withProfiles.length, 'roots must be deduplicated')
})

test('a missing package fails with an actionable message, not a silent skip', async () => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  await assert.rejects(
    locatePinnedDshMemory(requireFromPlugin, { dshHome: 'C:/definitely-not-a-real-dsh-home', listProfiles: async () => [] }),
    /未找到已安装的 @furongjun1999\/dsh-memory/,
  )
})

test('a wrong version is refused rather than patched blindly', async (t) => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  const hasReal = await exists(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@furongjun1999', 'dsh-memory', 'package.json'))
  if (!hasReal) return t.skip('the pinned dsh-memory is not installed in this profile')
  await assert.rejects(
    locatePinnedDshMemory(requireFromPlugin, { expectedVersion: '0.0.0-not-installed' }),
    /隔离只经 0\.0\.0-not-installed 核验/,
  )
})

test('the installed dsh-memory resolves to a real package root with MdcgClient', async (t) => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  let found
  try {
    found = await locatePinnedDshMemory(requireFromPlugin)
  } catch (error) {
    // On a machine without the plugin installed this is expected; the profile
    // check below is what matters on this machine.
    return t.skip(`dsh-memory is not resolvable here: ${error.message}`)
  }
  assert.equal(found.version, '0.8.1')
  assert.ok(found.packageRoot.includes('dsh-memory'))
  assert.equal(typeof found.MdcgClient, 'function')
  // The cold store runs `python -m md_cg.mcp_server` with this as PYTHONPATH,
  // so the Python package must actually live at the resolved root.
  assert.ok(await exists(path.join(found.packageRoot, 'md_cg', '__init__.py')), 'md_cg must exist at the resolved root')
})

test('the installed host half loads, registers its surface, and finds dsh-memory', async (t) => {
  if (!(await exists(installedEntry))) {
    return t.skip(`the plugin is not installed at ${installedEntry}`)
  }
  const module = await import(pathToFileURL(installedEntry).href)
  assert.equal(module.name, 'memory-context-lab')
  assert.deepEqual(module.inject, ['commands', 'sessionProjections'])

  const ctx = createStubContext()
  await module.apply(ctx)

  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab'])
  assert.deepEqual(ctx._projections.map((projection) => projection.key), ['memoryContextLab'])
  // Both features ride `agent/pre-step`: the cooler delegates then cools, and
  // recall is prepended so it can fold into the downstream enter decision —
  // the same seam the shipped `time-context` plugin uses. Nothing listens on
  // `system-prompt/assemble`, which has no way to reach a session.
  //
  // `domain/changed` is the archive signal: the archive set is the `workspace`
  // domain's global singleton, so watching it catches every archive — including an
  // idle session, which never dispatches `workspace/session-stop`.
  assert.deepEqual([...ctx._listeners.keys()].sort(), ['agent/pre-step', 'domain/changed'])
  assert.equal(ctx._listeners.get('agent/pre-step').length, 2)
  assert.equal(ctx._listeners.get('domain/changed').length, 1)
  assert.deepEqual(ctx._prependEvents, ['agent/pre-step'])

  // The whole point of the DSH-home fallback: no compatibility warning here.
  assert.deepEqual(ctx._warnings, [], `the installed load must resolve dsh-memory cleanly, got: ${ctx._warnings.join(' | ')}`)

  // The client-facing view must be plain JSON with no undefined holes.
  const projection = ctx._projections[0]
  const view = projection.wire.view(projection.init())
  assert.deepEqual(Object.keys(view).sort(), [
    'archiveBatchSize', 'archived', 'auto', 'autoRecall', 'autoRestore', 'enabled',
    'restored', 'retainOperations', 'revision',
  ].sort())
  for (const [key, value] of Object.entries(view)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('the installed host half registers a command that records its input', async (t) => {
  if (!(await exists(installedEntry))) return t.skip('not installed')
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext()
  await module.apply(ctx)
  const command = ctx._commands[0]
  assert.equal(command.definitionId, 'dsh-memory-context-lab/control')
  // `recordInput` must stay unset: the default writes the raw line to
  // `command/run`, and the session projection folds exactly that record.
  assert.equal(command.recordInput, undefined)
  assert.ok(typeof command.input?.hint === 'string' && command.input.hint.includes('on'))
  assert.equal(typeof command.handler, 'function')
})

test('the client bundle ships beside the host half and declares its client section', async (t) => {
  const root = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-memory-context-lab')
  if (!(await exists(root))) return t.skip('not installed')
  assert.ok(await exists(path.join(root, 'src', 'client.js')), 'the client bundle must be installed')
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
})
