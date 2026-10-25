/**
 * v3 架构守卫：依赖方向红线（开发计划-v3 §2.2 / §2.7）。
 *
 * ## 缺陷
 * v2 的策略散在 adapter 与 UI 里、domain 依赖宿主对象的教训（计划 §1.3「重建」清单）。
 * v3 立骨架第一天就把「domain 不依赖 DSH/文件系统/MCP/UI；ports 不依赖 domain；
 * contracts 零运行时依赖」变成会失败的断言，而不是 README 里的承诺。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.2 依赖方向硬规则、§2.3 建议目录；src/v3/README.md 依赖方向表。
 *
 * ## 断言组
 * 1. 量具自检：真实 src/v3 至少扫到 3 个 .mjs、至少 1 条 import（扫描面为空 → 恒绿是假守卫；
 *    contracts/ports 按设计零依赖，全 v3 现仅 domain 一条真实 import，故阈值为 1）。
 * 2. 真实 src/v3 无任何层违规。
 * 3. 定点变异自证：临时树注入 domain→node:fs、domain→裸包名与根目录散文件，守卫必须点名；
 *    同规则下真实合法文件 0 违规（防误杀对照）。
 *
 * ## 不适用条件与已知边界
 * - 只做静态 import 提取（正则），不解析动态 import() 与 createRequire——v3 约定不使用
 *   这两种形态；引入时须扩本守卫。
 * - 守卫绿 ≠ 全仓清净：application/projection/observability 层尚未入驻，层规则已登记，
 *   入驻即受约束。外部依赖（node:* 与裸包名）只允许出现在 adapters/projection/
 *   observability 三层（宿主与第三方不进 contracts/ports/domain/application/shared）。
 *
 * ## 运行
 * node --test-force-exit test/v3-architecture-guard.test.mjs（已接 npm test）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const v3Root = path.join(here, '..', 'src', 'v3')

/** 静态提取 import/export-from 的 specifier（含纯副作用 import）。 */
function importSpecifiersOf(source) {
  const specs = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\w$\{\},\s*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:\*)?(?:[\w$\{\},\s*]+)?\s+from\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1])
  }
  return specs
}

/** 相对 specifier 归并为绝对路径；非相对（裸包名/node:）原样返回。 */
function resolveSpec(file, spec) {
  if (!spec.startsWith('.')) return spec
  return path.resolve(path.dirname(file), spec)
}

/** 层规则（计划 §2.2）：该层允许依赖的目录前缀集合。 */
const LAYER_ALLOW = {
  composition: ['composition', 'adapters', 'projection', 'observability', 'application', 'domain', 'ports', 'contracts', 'shared'],
  entry: ['entry', 'composition', 'adapters', 'projection', 'observability', 'application', 'domain', 'ports', 'contracts', 'shared'],
  contracts: ['contracts', 'shared'],
  ports: ['ports', 'contracts', 'shared'],
  domain: ['domain', 'contracts', 'shared'],
  application: ['application', 'domain', 'ports', 'contracts', 'shared'],
  adapters: ['adapters', 'projection', 'observability', 'application', 'domain', 'ports', 'contracts', 'shared'],
  projection: ['adapters', 'projection', 'observability', 'application', 'domain', 'ports', 'contracts', 'shared'],
  observability: ['adapters', 'projection', 'observability', 'application', 'domain', 'ports', 'contracts', 'shared'],
  shared: ['shared'],
}

/** 扫描 root 下全部 .mjs，返回违规清单 [{file, spec, reason}]。 */
async function scanViolations(root) {
  const violations = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs')) {
        const rel = path.relative(root, full)
        const layer = rel.split(path.sep)[0]
        const allow = LAYER_ALLOW[layer]
        if (allow === undefined) {
          violations.push({ file: rel, spec: null, reason: '未登记的层目录' })
          continue
        }
        const source = await readFile(full, 'utf8')
        for (const spec of importSpecifiersOf(source)) {
          const resolved = resolveSpec(full, spec)
          if (resolved === spec) {
            if (!['adapters', 'projection', 'observability', 'composition'].includes(layer)) {
              violations.push({ file: rel, spec, reason: '外部依赖只允许出现在 adapters/projection/observability/composition 层' })
            }
            continue
          }
          const targetLayer = path.relative(root, resolved).split(path.sep)[0]
          if (!allow.includes(targetLayer)) {
            violations.push({ file: rel, spec, reason: '跨层依赖：' + targetLayer + ' 不在 ' + layer + ' 的允许清单' })
          }
        }
      }
    }
  }
  await walk(root)
  return violations
}

test('量具自检：扫描面非空（≥3 个 .mjs、≥1 条 import）', async () => {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs')) files.push(full)
    }
  }
  await walk(v3Root)
  assert.ok(files.length >= 3, 'src/v3 扫描面为空或过小（' + files.length + ' 个 .mjs），守卫将恒绿')
  let importCount = 0
  for (const file of files) importCount += importSpecifiersOf(await readFile(file, 'utf8')).length
  assert.ok(importCount >= 1, '未提取到任何 import，正则可能失配')
})

test('真实 src/v3 无层违规', async () => {
  const violations = await scanViolations(v3Root)
  assert.deepEqual(violations, [], '依赖方向违规必须清零')
})

test('定点变异自证 + 防误杀对照', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'mcl-v3-arch-guard-'))
  try {
    await writeFile(path.join(tmp, 'x.mjs'), '')
    await mkdir(path.join(tmp, 'domain'), { recursive: true })
    await writeFile(path.join(tmp, 'domain', 'a.mjs'), "import { readFile } from 'node:fs'\nimport x from 'some-npm-pkg'\n")
    const violations = await scanViolations(tmp)
    const specs = violations.map((v) => v.spec).filter(Boolean)
    assert.ok(specs.includes('node:fs'), 'domain→node:fs 必须被点名')
    assert.ok(specs.includes('some-npm-pkg'), 'domain→裸包名必须被点名')
    assert.ok(violations.some((v) => v.reason === '未登记的层目录'), '根目录散文件必须被点名')
    // 防误杀对照②：adapters 层的 node:fs 依赖是合法的（session-store 真实如此）
    await mkdir(path.join(tmp, 'adapters'), { recursive: true })
    await writeFile(path.join(tmp, 'adapters', 'a.mjs'), "import { readFile } from 'node:fs'\n")
    const withAdapter = await scanViolations(tmp)
    assert.ok(!withAdapter.some((v) => v.spec === 'node:fs' && v.file.includes(path.join('adapters', 'a.mjs'))), 'adapters 的 node:fs 不得误报')
    assert.equal((await scanViolations(v3Root)).length, 0, '防误杀：真实合法文件 0 违规')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
