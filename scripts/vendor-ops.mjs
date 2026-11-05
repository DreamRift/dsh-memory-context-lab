#!/usr/bin/env node
/**
 * Regenerate the vendored dsh-ops component and its full Windows Bash payload.
 *
 * The published tgz must contain both directories verbatim; this script is the
 * reproducible way to rebuild them from the pinned tarballs. It never downloads:
 * pass the two tarballs (or place them in the project-local cache) so the build
 * stays offline and hash-checked.
 *
 *   node scripts/vendor-ops.mjs --ensure
 *   node scripts/vendor-ops.mjs \
 *     --dsh-tgz ../dsh-ops/dsh-ops-0.5.0-alpha3.tgz \
 *     --bash-tgz ../.cache/ops-vendor/bash-win32-x64-0.2.1.tgz
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROJECT = path.dirname(ROOT)
const VENDOR = path.join(ROOT, 'vendor')
const DSH_DIR = path.join(VENDOR, 'dsh-ops')
const BASH_DIR = path.join(VENDOR, 'bash-win32-x64')

const DSH_VERSION = '0.5.0-alpha3'
const DSH_SHA256 = '05d7e3ae1d4f0ae3cb5d6fb2849577c2c15e0a1f09d35a9bf294f420005ffa00'
const BASH_VERSION = '0.2.1'
const BASH_SHA512 = 'qK7Pm8ioRkjf+UBAqPOhogB0iPX/tBUmBhQSMdrBVJKOQjeLDHluRDOx1JdLHfxhW+oUJdu19TG/HXxDa9o7zw=='

/** The dsh-ops subset that runs; source/tests/docs/README stay out of the package. */
const DSH_FILES = ['package.json', 'dsh-plugin.json', 'LICENSE', 'NOTICE']
const DSH_DIRS = ['lib', 'runtime', 'bin', 'locale', 'licenses']
const DSH_ICON = path.join('docs', 'assets', 'icon.png')

function fail(message) {
  console.error('vendor-ops: ' + message)
  process.exit(1)
}

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function extract(tgz, into) {
  ensureDir(into)
  const result = spawnSync('tar', ['-xzf', tgz, '-C', into], { stdio: 'inherit' })
  if (result.status !== 0) fail('tar failed for ' + tgz)
}

function ensure() {
  if (!existsSync(path.join(DSH_DIR, 'package.json')) || !existsSync(path.join(BASH_DIR, 'package.json'))) {
    fail('vendor is missing; run this script with --dsh-tgz and --bash-tgz')
  }
  const dsh = JSON.parse(readFileSync(path.join(DSH_DIR, 'package.json'), 'utf8'))
  const bash = JSON.parse(readFileSync(path.join(BASH_DIR, 'package.json'), 'utf8'))
  if (dsh.name !== 'dsh-ops' || dsh.version !== DSH_VERSION) fail('vendor/dsh-ops is not ' + DSH_VERSION)
  if (bash.name !== '@dsh-ops/bash-win32-x64' || bash.version !== BASH_VERSION) fail('vendor/bash-win32-x64 is not ' + BASH_VERSION)
  const receipt = path.join(DSH_DIR, 'runtime', 'win32-x64', 'bash-ipc', 'provenance.json')
  if (!existsSync(receipt)) fail('vendor/dsh-ops lacks the Bash IPC receipt; run npm run build:bash-ipc before packing')
  console.log('vendor-ops: present (' + DSH_VERSION + ' + bash ' + BASH_VERSION + ' + bash-ipc)')
}

if (process.argv.includes('--ensure')) {
  ensure()
  process.exit(0)
}

const dshTgz = path.resolve(argOf('--dsh-tgz') ?? path.join(PROJECT, 'dsh-ops', 'dsh-ops-' + DSH_VERSION + '.tgz'))
const bashTgz = path.resolve(argOf('--bash-tgz') ?? path.join(PROJECT, '.cache', 'ops-vendor', 'bash-win32-x64-' + BASH_VERSION + '.tgz'))
if (!existsSync(dshTgz)) fail('missing dsh-ops tarball: ' + dshTgz)
if (!existsSync(bashTgz)) fail('missing Bash payload tarball: ' + bashTgz)
if (sha256(dshTgz) !== DSH_SHA256) fail('dsh-ops tarball sha256 mismatch')
if (sha512Base64(bashTgz) !== BASH_SHA512) fail('Bash payload integrity mismatch')

const work = path.join(tmpdir(), 'mcl-vendor-ops-' + process.pid)
rmSync(work, { recursive: true, force: true })
ensureDir(work)
try {
  extract(dshTgz, path.join(work, 'dsh'))
  extract(bashTgz, path.join(work, 'bash'))
  const dshSrc = path.join(work, 'dsh', 'package')
  const bashSrc = path.join(work, 'bash', 'package')
  rmSync(DSH_DIR, { recursive: true, force: true })
  rmSync(BASH_DIR, { recursive: true, force: true })
  ensureDir(DSH_DIR)
  for (const file of DSH_FILES) cpSync(path.join(dshSrc, file), path.join(DSH_DIR, file))
  for (const dir of DSH_DIRS) cpSync(path.join(dshSrc, dir), path.join(DSH_DIR, dir), { recursive: true })
  ensureDir(path.join(DSH_DIR, 'docs', 'assets'))
  cpSync(path.join(dshSrc, DSH_ICON), path.join(DSH_DIR, DSH_ICON))
  cpSync(bashSrc, BASH_DIR, { recursive: true })

  const record = {
    generatedAt: new Date().toISOString(),
    dshOps: { version: DSH_VERSION, tarballSha256: DSH_SHA256, file: path.basename(dshTgz) },
    bash: { version: BASH_VERSION, tarballSha512: BASH_SHA512, file: path.basename(bashTgz) },
  }
  writeFileSync(path.join(VENDOR, 'VENDOR.json'), JSON.stringify(record, null, 2) + '\n')
  console.log('vendor-ops: wrote ' + VENDOR)
} finally {
  rmSync(work, { recursive: true, force: true })
}
