/**
 * Lingshu (`@furongjun1999/dsh-memory`) integration: locating the installed
 * package, and suppressing its automatic per-session hooks while this plugin
 * owns a session.
 *
 * Two independent needs share one lookup:
 *
 *   - the isolated cold store spawns `python -m md_cg.mcp_server` with
 *     `PYTHONPATH` pointed at the package root, so that directory must exist;
 *   - the suppression patches `MdcgClient.prototype`, a private interface, so
 *     the exact version is verified before anything is patched.
 *
 * Neither touches the model-visible tool set. Suppression replaces method
 * *results* for one session; it never registers, hides, or removes a tool.
 */

import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { InvalidArgumentError, EngineV2Error } from './errors.mjs'

const SUPPRESSION_KEY = Symbol.for('dsh-memory-context-lab/suppression-v1')
/**
 * Versions whose automatic-hook calls were audited against the patch below.
 * 0.9.8 was verified individually (2026-10-20): all five prototype methods
 * still exist, both suppressed readers return the same fallback shape, and
 * restore() leaves the prototype with the same own-property count. The hook
 * call shapes are unchanged as well -- `read/2` still takes `{ session }` as
 * its second argument, `remember/2` as `{ ...sessionTag }`, and
 * `sessionRecall/1`/`timeline/1` still carry the session first.
 *
 * 0.9.10 was verified individually (2026-10-22, the version installed in this
 * machine's profile -- 0.9.8 was already gone from it, so the guard failed
 * closed on every load and the isolation was silently unavailable):
 *   - all five prototype methods still exist with the same arity and order:
 *     remember(content, extra), recentAdd(role, text, meta, tags),
 *     read(query, extra), timeline(limit, extra), sessionRecall(session, ...);
 *   - lib/hooks.js still passes the exact-session tag where the patch looks:
 *     remember(safe, { ...sessionTag }), read(text, { k: 3, ...sessionTag }),
 *     recentAdd(role, text, { ...sessionTag }, ['dsh', 'recent-window']),
 *     timeline(limit, { session: sid }), sessionRecall(sid, ...);
 *   - md_cg/ still sits at the package root and lib/lib/mdcg_client.js still
 *     exports MdcgClient.
 * Anything outside this list keeps failing closed: the guard is about the
 * private prototype contract, not about semver optimism.
 */
export const EXPECTED_DSH_MEMORY_VERSIONS = ['0.8.1', '0.9.8', '0.9.10']
const EXPECTED_DSH_MEMORY_VERSION = EXPECTED_DSH_MEMORY_VERSIONS[EXPECTED_DSH_MEMORY_VERSIONS.length - 1]
const PACKAGE_NAME = '@furongjun1999/dsh-memory'

function normalizedSession(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** The exact-session tag each patched automatic hook passes, per method. */
function sessionFor(method, args) {
  switch (method) {
    case 'remember': return normalizedSession(args[1]?.session)
    case 'recentAdd': return normalizedSession(args[2]?.session)
    case 'read': return normalizedSession(args[1]?.session)
    case 'timeline': return normalizedSession(args[1]?.session)
    case 'sessionRecall': return normalizedSession(args[0])
    default: return ''
  }
}

/** The shape each suppressed reader must return so callers see "nothing". */
function fallbackFor(method) {
  switch (method) {
    case 'read':
    case 'timeline': return { results: [], items: [], nodes: [], count: 0, skipped: 'memory-context-lab' }
    case 'sessionRecall': return { recent: [], notes: [], goals: [], tasks: [], unresolved: [], skipped: 'memory-context-lab' }
    default: return { ok: true, skipped: 'memory-context-lab' }
  }
}

/**
 * Patch only the known 0.8.1 automatic-hook calls. Every hook passes an exact
 * session tag; a call without one is deliberately never blocked, so another
 * session cannot be affected by this plugin.
 */
export function createSuppressionCoordinator(MdcgClient) {
  if (!MdcgClient?.prototype) throw new InvalidArgumentError('dsh-memory 未导出可兼容的 MdcgClient。', { code: 'EBACKENDUNAVAILABLE' })
  const prototype = MdcgClient.prototype
  const methods = ['remember', 'recentAdd', 'read', 'timeline', 'sessionRecall']
  const originals = new Map()
  const patched = new Map()
  const active = new Map()
  const stats = new Map()
  let installed = false

  function isActive(sessionId) {
    return (active.get(sessionId) ?? 0) > 0
  }

  function record(sessionId, kind) {
    const current = stats.get(sessionId) ?? { write: 0, read: 0 }
    current[kind] += 1
    stats.set(sessionId, current)
  }

  function install() {
    if (installed) return
    // Pre-flight every method before touching the prototype. Patching inside the
    // same loop meant a later missing method left the earlier ones already
    // replaced while installed stayed false -- restore() would then never run, and
    // the global dsh-memory hooks stayed half-patched for the life of the process.
    const plan = []
    for (const method of methods) {
      const original = prototype[method]
      if (typeof original !== 'function') throw new InvalidArgumentError(`已核验的 dsh-memory 缺少 MdcgClient.${method}，已拒绝启用抑制。`, { code: 'EBACKENDUNAVAILABLE' })
      plan.push({ method, original, descriptor: Object.getOwnPropertyDescriptor(prototype, method) })
    }
    for (const { method, original, descriptor } of plan) {
      const wrapper = function memoryContextLabSuppressedCall(...args) {
        const sessionId = sessionFor(method, args)
        if (!sessionId || !isActive(sessionId)) return original.apply(this, args)
        record(sessionId, method === 'remember' || method === 'recentAdd' ? 'write' : 'read')
        return Promise.resolve(fallbackFor(method))
      }
      patched.set(method, wrapper)
      originals.set(method, descriptor)
      Object.defineProperty(prototype, method, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: wrapper,
      })
    }
    installed = true
  }

  function restore() {
    if (!installed) return
    for (const method of methods) {
      // Avoid overwriting a later compatible owner if a hot reload changed it.
      if (prototype[method] !== patched.get(method)) continue
      const descriptor = originals.get(method)
      if (descriptor) {
        Object.defineProperty(prototype, method, descriptor)
      } else {
        // The method was inherited, so install() created an own property that
        // shadows it; deleting that own property is the only way back.
        delete prototype[method]
      }
    }
    originals.clear()
    patched.clear()
    installed = false
  }

  function acquire(sessionId) {
    const sid = normalizedSession(sessionId)
    if (!sid) throw new InvalidArgumentError('会话没有可用标识，已拒绝启用抑制。', { code: 'ENOSESSION' })
    install()
    active.set(sid, (active.get(sid) ?? 0) + 1)
    let released = false
    return {
      release() {
        if (released) return
        released = true
        const count = active.get(sid) ?? 0
        if (count <= 1) active.delete(sid)
        else active.set(sid, count - 1)
        // The counters describe one acquisition. Keeping them past the last
        // release is how a long-lived host accumulated two integers per session
        // forever, so they go when the session stops being suppressed.
        if (!isActive(sid)) stats.delete(sid)
        if (active.size === 0) restore()
      },
      stats() {
        const value = stats.get(sid) ?? { write: 0, read: 0 }
        return { write: value.write, read: value.read }
      },
    }
  }

  return {
    acquire,
    activeCount: () => active.size,
    dispose: () => {
      active.clear()
      stats.clear()
      restore()
    },
  }
}

async function directoryWithManifest(candidate) {
  const resolved = path.resolve(candidate)
  try {
    await access(path.join(resolved, 'package.json'))
    return await realpath(resolved)
  } catch {
    return null
  }
}

/**
 * Every `node_modules` directory that could hold the installed package.
 *
 * The ordinary Node lookup comes first. The DSH home candidates matter because
 * a workspace-linked plugin resolves through its real path: `createRequire`
 * then walks the *workspace* tree and never sees the profile that actually
 * installed dsh-memory. Without this fallback a linked checkout silently loses
 * both the cold store and suppression.
 *
 * @param options.requireFromPlugin - a `createRequire` bound to this plugin.
 * @param options.dshHome - the DSH home directory; defaults to `$DSH_HOME` or `~/.dsh`.
 * @param options.listProfiles - injectable for tests.
 */
export async function dshMemoryLookupRoots({ requireFromPlugin, dshHome, listProfiles } = {}) {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || !value) return
    const resolved = path.resolve(value)
    if (!roots.includes(resolved)) roots.push(resolved)
  }

  try {
    for (const nodeModules of requireFromPlugin?.resolve?.paths?.(PACKAGE_NAME) ?? []) push(nodeModules)
  } catch {
    // A resolution failure here is expected; the DSH home candidates follow.
  }

  const home = dshHome ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const list = listProfiles ?? defaultListProfiles
  for (const profile of await list(home)) push(path.join(profile, 'node_modules'))
  push(path.join(home, 'node_modules'))
  return roots
}

/** Directories under `$DSH_HOME/profiles`, ignoring anything unreadable. */
async function defaultListProfiles(dshHome) {
  try {
    const entries = await readdir(path.join(dshHome, 'profiles'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dshHome, 'profiles', entry.name))
  } catch {
    return []
  }
}

/**
 * Find the installed dsh-memory package and verify its version before use.
 *
 * @throws when the package is absent, unreadable, the wrong version, or missing
 *   the `MdcgClient` export — the caller degrades rather than guessing.
 */
export async function locatePinnedDshMemory(requireFromPlugin, options = {}) {
  const { expectedVersion, ...lookup } = options
  const acceptedVersions = expectedVersion === undefined
    ? EXPECTED_DSH_MEMORY_VERSIONS
    : [expectedVersion]
  const roots = await dshMemoryLookupRoots({ requireFromPlugin, ...lookup })

  let packageRoot = null
  for (const nodeModules of roots) {
    packageRoot = await directoryWithManifest(path.join(nodeModules, ...PACKAGE_NAME.split('/')))
    if (packageRoot) break
  }
  if (!packageRoot) {
    throw new InvalidArgumentError(`未找到已安装的 ${PACKAGE_NAME}；已搜索 ${roots.length} 个 node_modules 根。`, { code: 'ENOTINSTALLED' })
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    throw new InvalidArgumentError('无法读取已安装 dsh-memory 的版本信息，已拒绝启用抑制。', { code: 'EBACKENDUNAVAILABLE' })
  }
  if (manifest?.name !== PACKAGE_NAME || !acceptedVersions.includes(manifest.version)) {
    throw new InvalidArgumentError(`当前 dsh-memory=${String(manifest?.version ?? 'unknown')}，隔离只经 ${acceptedVersions.join(' / ')} 核验，已拒绝启用。`, { code: 'EVERSIONUNVERIFIED' })
  }
  const clientModule = await import(pathToFileURL(path.join(packageRoot, 'lib', 'lib', 'mdcg_client.js')).href)
  if (typeof clientModule.MdcgClient !== 'function') {
    throw new InvalidArgumentError('dsh-memory 未导出 MdcgClient，已拒绝启用抑制。', { code: 'EBACKENDUNAVAILABLE' })
  }
  return { packageRoot, MdcgClient: clientModule.MdcgClient, version: manifest.version }
}

/**
 * One process may hot-reload this bundle. A global coordinator prevents one
 * copy from restoring the private prototype patch while another still owns a
 * session lease.
 */
export function globalSuppressionCoordinator(MdcgClient) {
  const current = globalThis[SUPPRESSION_KEY]
  if (current?.MdcgClient === MdcgClient) return current.coordinator
  if (current?.coordinator?.activeCount?.() > 0) {
    throw new EngineV2Error('已有不同版本的隔离抑制仍在运行，已拒绝混用。', { code: 'ECONFLICT' })
  }
  current?.coordinator?.dispose?.()
  const coordinator = createSuppressionCoordinator(MdcgClient)
  globalThis[SUPPRESSION_KEY] = { MdcgClient, coordinator }
  return coordinator
}
