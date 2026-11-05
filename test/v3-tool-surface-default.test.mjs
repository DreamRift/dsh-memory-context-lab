/**
 * 0.15.1 组件面守卫：bundle 内两个组件行 + 定制 dsh-ops 的完整载荷。
 *
 * 背景：0.15.0 审计轮曾以「默认替换官方工具且未验收」为由移除第二条 dsh-ops 行，
 * 并把「只能有一个组件行」钉成静态事实。0.15.1 用户拍板恢复该组件，但换成了
 * **真正随 tgz 分发的 vendored 形态**：
 * - dsh-ops 是记忆上下文的 file: 依赖，不单独进 dsh.profile.bundles；
 * - 插件页「包含的组件」显示 memory-context-lab 与 dsh-ops 两行；
 * - dsh-ops 的 Windows Bash 载荷随包携带，默认 bash: true；
 * - 仍然 hidePwsh: false、dynamicTools: false、discovery: false。
 *
 * 本套件把这些事实钉死，防止再次被误删或误改回「单组件 / 无载荷」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function uncommented(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

test('0.15.1 patch 声明两个组件行：memory-context-lab 与 dsh-ops', async () => {
  const patch = await readFile(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  const config = uncommented(patch)
  assert.equal((config.match(/^\s*- id:/gm) ?? []).length, 2, '必须恰好两个组件行')
  assert.match(config, /^\s+- id: memory-context-lab\s*$/m)
  assert.match(config, /^\s+name: dsh-memory-context-lab\s*$/m)
  assert.match(config, /^\s+- id: dsh-ops\s*$/m)
  assert.match(config, /^\s+name: dsh-ops\s*$/m)
})

test('0.15.1 dsh-ops 默认值：bash 开、官方工具替换开、pwsh 保留、动态发现关', async () => {
  const patch = uncommented(await readFile(path.join(ROOT, 'cordis.patch.yml'), 'utf8'))
  const lines = patch.split('\n').map((line) => line.trim())
  for (const expected of [
    'bash: true',
    'hidePwsh: false',
    'hideOfficialTools: true',
    'dynamicTools: false',
  ]) {
    assert.ok(lines.includes(expected), 'dsh-ops 配置必须包含 ' + expected)
  }
  const discovery = patch.slice(patch.indexOf('discovery:'))
  assert.match(discovery, /enabled: false/)
})

test('0.15.1 包清单把 dsh-ops 与 Bash 载荷声明为 vendored 依赖', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  // 版本号不钉死具体值（每次升号都要改守卫是自伤的）；钉「稳定版本号形态」+「README 版本行同源」。
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号必须是 x.y.z 形态')
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8')
  const readmeVersion = readme.match(/当前源码版本\s+(\S+?)（/)
  assert.ok(readmeVersion, 'README 版本行存在（含「当前源码版本」锚）')
  assert.equal(readmeVersion[1], pkg.version, 'README 版本行必须与 package.json 一致')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dependencies['dsh-ops'], 'file:./vendor/dsh-ops')
  assert.equal(pkg.optionalDependencies['@dsh-ops/bash-win32-x64'], 'file:./vendor/bash-win32-x64')
  assert.ok(pkg.files.includes('vendor/dsh-ops'), '发布包必须包含 vendor/dsh-ops')
  assert.ok(pkg.files.includes('vendor/bash-win32-x64'), '发布包必须包含 Windows Bash 载荷')
  assert.equal(pkg.files.includes('scripts'), false, '发布包不得包含 scripts/')
})

test('0.15.1 vendored dsh-ops 是组件而不是独立 bundle', async () => {
  const dir = path.join(ROOT, 'vendor', 'dsh-ops')
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-ops')
  assert.equal(manifest.version, '0.5.0-alpha3')
  assert.equal(manifest.dsh?.bundle, undefined, 'dsh-ops 不能声明 dsh.bundle，否则会变成独立插件卡片')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.exports?.['./client']?.default, './lib/client.js')
  const rowSchema = await readFile(path.join(dir, 'lib', 'client', 'row-schema.js'), 'utf8')
  assert.match(rowSchema, /ROW_CONFIG_BUNDLES = \['dsh-ops', 'dsh-memory-context-lab'\]/)
})

test('0.15.1 vendored 载荷是可执行的完整 Bash 树', async () => {
  const dir = path.join(ROOT, 'vendor', 'bash-win32-x64')
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@dsh-ops/bash-win32-x64')
  assert.equal(manifest.version, '0.2.1')
  assert.ok(existsSync(path.join(dir, 'bin', 'bash.exe')), '载荷必须含 bin/bash.exe')
  assert.ok(existsSync(path.join(dir, 'usr', 'bin', 'msys-2.0.dll')), '载荷必须含 MSYS 运行时')
  const ipc = path.join(ROOT, 'vendor', 'dsh-ops', 'runtime', 'win32-x64', 'bash-ipc')
  assert.ok(existsSync(path.join(ipc, 'provenance.json')), 'dsh-ops 必须带 Bash IPC 兼容回执（否则受限模式拒绝 ops_bash）')
  assert.ok(existsSync(path.join(ipc, 'opsipc.dll')), 'dsh-ops 必须带 opsipc.dll')
  assert.ok(existsSync(path.join(ipc, 'opsnt.dll')), 'dsh-ops 必须带 opsnt.dll')
})

test('0.15.1 固定三工具清单不变，文件核证认 ops 读文件工具', async () => {
  const tools = await import('../src/v3/contracts/tools.mjs')
  assert.deepEqual([...tools.MEMORY_CONTEXT_TOOL_LIST], [
    'memory_context_search',
    'memory_context_read',
    'memory_context_compact',
  ])
  const refs = await import('../src/v3/adapters/storage/file-references.mjs')
  const target = refs.fileTargetOf({
    type: 'tool/call',
    data: { name: 'ops_inspect_local_file', arguments: JSON.stringify({ path: 'src/index.mjs' }) },
  })
  assert.deepEqual(target, { tool: 'ops_inspect_local_file', path: 'src/index.mjs' })
})

test('0.15.1 源码里不重新引入 I3 dsh-ops 适配器或诊断接线', async () => {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(path.join(ROOT, 'src', 'v3', 'adapters'))
  assert.equal(entries.includes('dsh-ops'), false, 'I3 adapter 目录必须不存在；组件行由 patch + 包依赖承载')
  const composition = await readFile(path.join(ROOT, 'src', 'v3', 'composition', 'composition.mjs'), 'utf8')
  assert.equal(/createDshOpsAdapter|dshOps:/.test(composition), false)
})
