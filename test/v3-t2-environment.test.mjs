/**
 * T2 隔离环境定位回归（beta.35 真机缺陷）。
 *
 * 真机现象：装到 profile 后 `/memory-lab t2` 报「未找到 dsh-memory 环境」，但
 * `MEMORY_LAB_T2_REPO` 一指定就正常。根因是 pnpm 把本包真实路径放在
 * `node_modules/.pnpm/...`，而 `@furongjun1999/dsh-memory` 是 profile 顶层依赖，
 * 不是本包依赖——`createRequire(import.meta.url).resolve()` 永远看不到它。
 *
 * 判据：即使 require.resolve 失败，也要能从目录祖先的 node_modules 找到包根；
 * 找不到标准是「md_cg/mcp_server.py 真实存在」，不是只看目录名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { resolveT2Isolated } from '../src/v3/adapters/host/t2-environment.mjs'

const SOURCE = fileURLToPath(new URL('../src/v3/adapters/host/t2-environment.mjs', import.meta.url))

async function withSimulatedProfile(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t2-env-'))
  try {
    const memory = path.join(root, 'node_modules', '@furongjun1999', 'dsh-memory')
    await mkdir(path.join(memory, 'md_cg'), { recursive: true })
    // 没有 main/index.js：require.resolve 必失败，逼出「目录祖先扫描」分支。
    await writeFile(path.join(memory, 'package.json'), JSON.stringify({ name: '@furongjun1999/dsh-memory', version: '0.9.10' }) + '\n', 'utf8')
    await writeFile(path.join(memory, 'md_cg', 'mcp_server.py'), '# test\n', 'utf8')
    const pluginHost = path.join(root, 'node_modules', 'dsh-memory-context-lab', 'src', 'v3', 'adapters', 'host')
    await mkdir(pluginHost, { recursive: true })
    const copied = path.join(pluginHost, 't2-environment.mjs')
    await cp(SOURCE, copied)
    return await body({ root, memory, copied })
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('require.resolve 看不到顶层 dsh-memory 时，仍能从目录祖先找到（真机回归）', async () => {
  await withSimulatedProfile(async ({ memory, copied }) => {
    const module = await import(pathToFileURL(copied).href + '?t=' + Date.now())
    const resolved = await module.resolveT2Isolated({ env: {} })
    assert.notEqual(resolved, null, '不能因为本包不是 dsh-memory 的依赖就判「未安装」')
    assert.equal(path.resolve(resolved.repoRoot), path.resolve(memory))
    assert.equal(resolved.version, '0.9.10')
    assert.equal(resolved.source, 'profile')
  })
})

test('显式 MEMORY_LAB_T2_REPO 优先；缺 md_cg 时仍为 null', async () => {
  assert.equal(await resolveT2Isolated({ env: { MEMORY_LAB_T2: '0' } }), null)
  assert.equal(await resolveT2Isolated({ env: { MEMORY_LAB_T2_REPO: 'C:/definitely/not/a/repo' } }), null)
})

test('md_cg 不存在时目录祖先扫描不得误报', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t2-env-empty-'))
  try {
    const memory = path.join(root, 'node_modules', '@furongjun1999', 'dsh-memory')
    await mkdir(memory, { recursive: true })
    await writeFile(path.join(memory, 'package.json'), '{"name":"@furongjun1999/dsh-memory","version":"0.9.10"}\n', 'utf8')
    const pluginHost = path.join(root, 'node_modules', 'dsh-memory-context-lab', 'src', 'v3', 'adapters', 'host')
    await mkdir(pluginHost, { recursive: true })
    const copied = path.join(pluginHost, 't2-environment.mjs')
    await cp(SOURCE, copied)
    const module = await import(pathToFileURL(copied).href + '?t=' + Date.now())
    assert.equal(await module.resolveT2Isolated({ env: {} }), null)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('源码树运行：模块祖先找不到时，从 DSH_HOME/profiles 找（t2-smoke 无 --repo 的根因）', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-t2-home-'))
  try {
    const memory = path.join(home, 'profiles', 'desktop', 'node_modules', '@furongjun1999', 'dsh-memory')
    await mkdir(path.join(memory, 'md_cg'), { recursive: true })
    await writeFile(path.join(memory, 'package.json'), JSON.stringify({ name: '@furongjun1999/dsh-memory', version: '0.9.10' }) + '\n', 'utf8')
    await writeFile(path.join(memory, 'md_cg', 'mcp_server.py'), '# test\n', 'utf8')
    const work = path.join(home, 'work', 'src', 'v3', 'adapters', 'host')
    await mkdir(work, { recursive: true })
    const copied = path.join(work, 't2-environment.mjs')
    await cp(SOURCE, copied)
    const module = await import(pathToFileURL(copied).href + '?t=' + Date.now())
    const resolved = await module.resolveT2Isolated({ env: { DSH_HOME: home } })
    assert.notEqual(resolved, null, '源码树不在 profile 下，也必须能从 DSH_HOME 找到')
    assert.equal(path.resolve(resolved.repoRoot), path.resolve(memory))
    assert.equal(resolved.source, 'profile-root')
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
