/**
 * G6b 源码级守卫（R-5 + 默认关闭）。
 *
 * ## 为什么需要导入级守卫
 * G3 已经证明「观测不参与决策」必须靠**导入级**断言钉住（C7：application/domain
 * 不得导入观测合同/账本）。可见性判定是去重输入，同样不能被诊断日志污染：
 * 一旦 visibility 模块导入 cache-observation / usage-log / observation-*，判定就可能
 * 偷偷读观测数据，把「日志里有」当成「活动面上可见」（合同 §1.2 明令禁止）。
 *
 * ## 断言组
 * 1. visibility 模块（contracts/visibility.mjs + domain/visibility/**）零观测导入、
 *    零 node:* 导入、依赖方向只到 contracts/shared/domain；
 * 2. recall.mjs（唯一消费者）同样零观测导入；
 * 3. 装配面（index/entry/composition）零引用 —— 候选默认关闭，接线属集成分批；
 * 4. 量具自检：植入一条观测 import / 一条 visibility 引用时必须被同一判据点名。
 *
 * ## 不适用条件
 * 只做静态 import 提取（正则），不解析动态 import()/createRequire（v3 约定不使用）。
 * 真实宿主装配未验：这里只证明「没有暗线」和「候选确实没接进装配面」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')
const V3 = path.join(SRC, 'v3')

/** 观测面模块（G3 的合同与账本；visibility 一律不得导入）。 */
const OBSERVATION_PATTERN = /(cache-observation|usage-log|observation-)/

const ASSEMBLY_FILES = ['index.mjs', 'v3/entry/v3-entry.mjs', 'v3/composition/composition.mjs']

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

async function listFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/** 判据（同一份实现给真实文件与植入样本用，避免「量具写歪」）。 */
function ruleViolations(file, source) {
  const violations = []
  const layer = path.relative(V3, file).split(path.sep)[0]
  for (const spec of importSpecifiersOf(source)) {
    if (OBSERVATION_PATTERN.test(spec)) {
      violations.push({ file, spec, reason: 'visibility 不得导入观测合同/账本（C-G3-05 同向）' })
      continue
    }
    if (!spec.startsWith('.')) {
      violations.push({ file, spec, reason: 'visibility 不得依赖外部包或 node:*' })
      continue
    }
    const target = path.relative(V3, path.resolve(path.dirname(file), spec)).split(path.sep)[0]
    const allowed = layer === 'contracts' ? ['contracts', 'shared'] : ['domain', 'contracts', 'shared']
    if (!allowed.includes(target)) {
      violations.push({ file, spec, reason: 'visibility 依赖方向越界（' + layer + ' → ' + target + '）' })
    }
  }
  return violations
}

test('G6b-S1 visibility 模块零观测导入、零外部依赖、依赖方向只到 contracts/shared/domain', async () => {
  const files = [path.join(V3, 'contracts', 'visibility.mjs'), ...(await listFiles(path.join(V3, 'domain', 'visibility')))]
  assert.ok(files.length >= 6, '扫描面异常：' + files.length)
  const violations = []
  for (const file of files) violations.push(...ruleViolations(file, await readFile(file, 'utf8')))
  assert.deepEqual(violations, [], 'visible 判定不得读观测数据：\n' + JSON.stringify(violations, null, 1))
})

test('G6b-S2 唯一消费者 recall.mjs 也零观测导入（决策路径不接诊断日志）', async () => {
  const source = await readFile(path.join(V3, 'application', 'recall.mjs'), 'utf8')
  const offenders = importSpecifiersOf(source).filter((spec) => OBSERVATION_PATTERN.test(spec))
  assert.deepEqual(offenders, [], 'recall 的去重路径不得导入观测模块')
  // 反向自证：它确实导入了可见性判定（否则上面的断言是「什么都没接」的假绿）
  assert.ok(importSpecifiersOf(source).some((spec) => spec.includes('visibility')), 'recall 必须真的接上 visibility 模块')
})

test('G6b-S3 装配面零引用：候选默认关闭，接线属集成分批', async () => {
  const scanned = []
  for (const rel of ASSEMBLY_FILES) {
    const source = await readFile(path.join(SRC, rel), 'utf8')
    assert.ok(source.length > 1000, rel + ' 内容异常，零引用断言会失去判别力')
    scanned.push(rel)
    // 2026-11-06（0.15.4）：判据只看**代码**，剥掉注释后再匹配。
    //
    // 本断言要拦的是「把候选接上装配面」（import、传参、调用），不是「提到这个名字」。
    // 旧写法对全文做字面匹配，导致装配面里连一句「此处不要加 dedupeVisible」的
    // 警告注释都会把守卫打红——那等于禁止记录这项决定，与 G6b 保留但登记的口径相悖。
    // 剥注释不放宽判据：真正的接线必然出现在代码行上（S4 的量具自检正是植入代码引用）。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.equal(/domain\/visibility|contracts\/visibility|dedupeVisible/.test(code), false, rel + ' 不得接上可见片段去重（候选默认关闭）')
  }
  assert.deepEqual(scanned, ASSEMBLY_FILES)
})

test('G6b-S4 量具自检：植入观测 import / 装配面引用时必须被同一判据点名', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-g6b-guard-'))
  try {
    const planted = path.join(dir, 'visibility.mjs')
    await mkdir(path.join(dir, 'visibility'), { recursive: true })
    await writeFile(planted, "import { buildCacheObservation } from '../../contracts/cache-observation.mjs'\nimport { readFile } from 'node:fs/promises'\n")
    const violations = ruleViolations(planted, await readFile(planted, 'utf8'))
    assert.ok(violations.some((v) => v.spec.includes('cache-observation')), '植入观测 import 必须被点名')
    assert.ok(violations.some((v) => v.spec === 'node:fs/promises'), '植入 node:* 必须被点名')
    // 防误杀：真实 visibility 文件必须 0 违规
    const real = await readFile(path.join(V3, 'domain', 'visibility', 'coverage.mjs'), 'utf8')
    assert.deepEqual(ruleViolations(path.join(V3, 'domain', 'visibility', 'coverage.mjs'), real), [])

    // 装配面判据自证：植入一行 visibility 引用必须让同一判据为真
    const assembly = await readFile(path.join(SRC, 'index.mjs'), 'utf8')
    assert.equal(/domain\/visibility|contracts\/visibility|dedupeVisible/.test(assembly), false)
    assert.equal(/dedupeVisible/.test(assembly + "\nconst x = { dedupeVisible: true }\n"), true)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('G6b-S5 visibility 判定文件不含字面 8000（模型可见文案由常量插值，P7-20 同族）', async () => {
  const files = [path.join(V3, 'contracts', 'visibility.mjs'), ...(await listFiles(path.join(V3, 'domain', 'visibility')))]
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.equal(/\b8000\b/.test(source), false, path.basename(file) + ' 不得另写字面 8000（回读上限只有单一真源）')
  }
})
