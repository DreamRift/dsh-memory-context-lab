/**
 * 宿主 schema 兼容性探针（可选，需要本机 DSH 安装）。
 *
 * 为什么存在：`memory_lab_recall` 的参数与输出 schema 必须是宿主真实支持的
 * JSON Schema 子集。子集边界只写在宿主代码里，猜错不会在测试替身上暴露——
 * `ctx.tools.register` 会抛 `UNSUPPORTED_SCHEMA`，而那条异常在运行时被吞成
 * 一条 warn，工具就静默不注册。本探针把两份 schema 直接喂给宿主自己的
 * `assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue`，
 * 让边界错误在开发期就失败。
 *
 * 不在仓库里携带宿主源码：运行时按需从本机 app.asar 提取到系统临时目录，
 * 跑完即删。用法（二选一）：
 *
 *   node test/helpers/host-schema-probe.mjs --asar "<DSH>/resources/app.asar"
 *   node test/helpers/host-schema-probe.mjs --host-tools <已备好的 dsh-tools 包根>
 *
 * 也可用环境变量 `DSH_ASAR` / `DSH_TOOLS_ROOT`。两者都没有时打印 SKIP 并以 0
 * 退出，不影响主测试链。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

import {
  V2_RECALL_TOOL_PARAMETERS,
  V2_RECALL_TOOL_OUTPUT_SCHEMA,
  createV2RecallTool,
} from '../../src/v2/tool.mjs'

/** 探针入口包：从它出发按 import 关系展开闭包。 */
const ENTRY_PACKAGE = '@deepseek-ai/dsh-tools'
/** 真正要加载的校验器文件（相对包根）。 */
const VALIDATOR_SUBPATH = 'lib/types/json-schema.js'

/**
 * 极简 asar 读取器：只解析头部目录表，产出「路径 → 数据偏移」索引。
 *
 * asar 头是 pickle 编码，但文件名与偏移都在可直接读的 JSON 区段里；这里不引入
 * 第三方依赖，够本探针用。
 */
function readAsarIndex(buffer) {
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(
    buffer.subarray(16, 16 + headerSize).toString('utf8').replace(/\0+$/, ''),
  )
  const dataStart = 16 + headerSize
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const childPath = `${prefix}/${name}`
      if (value.files) {
        walk(value, childPath)
      } else {
        entries.set(childPath, {
          offset: dataStart + Number(value.offset),
          size: Number(value.size),
        })
      }
    }
  }
  walk(header, '')
  return entries
}

/** 取某包在 asar 内的全部文件（路径 → 条目）。 */
function filesOfPackage(entries, packageName) {
  const marker = `/node_modules/${packageName}/`
  return [...entries.entries()]
    .filter(([filePath]) => filePath.includes(marker))
    .map(([filePath, entry]) => [filePath.slice(filePath.indexOf(marker) + marker.length), entry])
}

/**
 * 只从真正的 import / require 语句里取模块说明符。
 *
 * 不匹配任意引号字符串：宿主代码里还有 domain 名（`dsh-llm#llm`）之类
 * 长得像包名的字符串，按字符串抓会把它们误当依赖。
 */
function importSpecifiersOf(source) {
  const specifiers = []
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/**
 * 按 import 关系展开宿主包闭包，再把整个闭包提取到临时目录。
 *
 * 为什么是闭包而不是固定文件清单：`dsh-tools` 的校验器间接依赖
 * `dsh-llm`、`dsh-util-values`、`cordis`、`schemastery` 等十余个包，
 * 少一个就 `ERR_MODULE_NOT_FOUND`。闭包共约 2MB，按需展开即可，不必把
 * 238MB 的宿主源码全量落地。
 */
async function extractHostPackages(asarPath) {
  const buffer = await readFile(asarPath)
  const index = readAsarIndex(buffer)
  const readEntry = (entry) => buffer.subarray(entry.offset, entry.offset + entry.size)

  const closure = new Set()
  const queue = [ENTRY_PACKAGE]
  while (queue.length > 0) {
    const packageName = queue.shift()
    if (closure.has(packageName)) continue
    const packageFiles = filesOfPackage(index, packageName)
    // 找不到的包不致命：要么是无关的字符串（如 domain 名 `dsh-llm#llm`），
    // 要么真缺依赖——后者会在 import 时以 ERR_MODULE_NOT_FOUND 明确报出来。
    if (packageFiles.length === 0) continue
    closure.add(packageName)
    for (const [relative, entry] of packageFiles) {
      if (!relative.endsWith('.js') && !relative.endsWith('.mjs')) continue
      const source = readEntry(entry).toString('utf8')
      for (const specifier of importSpecifiersOf(source)) {
        const packageOf = /^(@deepseek-ai\/[^'"/]+)/.exec(specifier)?.[1]
        if (packageOf && !closure.has(packageOf)) queue.push(packageOf)
      }
    }
  }

  const staging = await mkdtemp(path.join(tmpdir(), 'mcl-host-schema-'))
  let fileCount = 0
  let byteCount = 0
  for (const packageName of closure) {
    for (const [relative, entry] of filesOfPackage(index, packageName)) {
      const target = path.join(staging, 'node_modules', ...packageName.split('/'), ...relative.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, readEntry(entry))
      fileCount += 1
      byteCount += entry.size
    }
  }
  const toolsRoot = path.join(staging, 'node_modules', ...ENTRY_PACKAGE.split('/'))
  return { staging, toolsRoot, packageCount: closure.size, fileCount, byteCount }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const failures = []
const lines = []
const record = (label, ok, detail = '') => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  <- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const violationText = (violations) => (Array.isArray(violations) ? JSON.stringify(violations) : String(violations))

/**
 * 校验一个值并归一成「是否有违规」。
 *
 * 宿主契约：`validateJsonSchemaValue` **返回违规数组**（空数组＝通过），
 * 不是抛异常——早期版本按抛异常判断，导致所有非法值都被误判成通过。
 * 同时兼容将来改成抛 HarnessError 的实现。
 */
function violationsOf(host, schema, value) {
  try {
    return host.validateJsonSchemaValue(schema, value, 'value') ?? []
  } catch (error) {
    return error?.violations ?? [error]
  }
}

const asarPath = argValue('--asar') ?? process.env.DSH_ASAR ?? null
const preparedToolsRoot = argValue('--host-tools') ?? process.env.DSH_TOOLS_ROOT ?? null

let staging = null
let toolsRoot = preparedToolsRoot
try {
  if (!toolsRoot && asarPath) {
    const extracted = await extractHostPackages(asarPath)
    staging = extracted.staging
    toolsRoot = extracted.toolsRoot
    // 闭包规模随宿主版本变化，所以打印实测值而不是写死在文档里。
    lines.push(`INFO 闭包 ${extracted.packageCount} 包 / ${extracted.fileCount} 文件 / ${(extracted.byteCount / 1048576).toFixed(1)} MB`)
  }
  if (!toolsRoot) {
    console.log('SKIP 未提供 --asar/--host-tools（见本文件头部用法）；跳过宿主 schema 探针。')
    process.exit(0)
  }

  const host = await import(pathToFileURL(path.join(toolsRoot, ...VALIDATOR_SUBPATH.split('/'))).href)

  // 1) 两份 schema 必须过宿主的「受支持子集」闸门。
  for (const [label, schema] of [
    ['parameters', V2_RECALL_TOOL_PARAMETERS],
    ['output.schema', V2_RECALL_TOOL_OUTPUT_SCHEMA],
  ]) {
    for (const [gate, fn] of [
      ['assertSupportedJsonSchema', host.assertSupportedJsonSchema],
      ['assertObjectJsonSchema', host.assertObjectJsonSchema],
    ]) {
      try {
        fn(schema)
        record(`${label} ${gate}`, true)
      } catch (error) {
        record(`${label} ${gate}`, false, violationText(error))
      }
    }
  }

  // 2) 参数校验必须真的拦下坏输入：子集「支持」不等于「会拦」。
  const cases = [
    ['空参数', {}, true],
    ['合法 ID 数组', { record_ids: ['t00000001-r0001'] }, true],
    ['合法查询', { query: 'call-1' }, true],
    ['合法预算', { budget_tokens: 8000 }, true],
    ['ID 非字符串', { record_ids: [7] }, false],
    ['ID 非数组', { record_ids: 't00000001-r0001' }, false],
    ['预算非整数', { budget_tokens: 'many' }, false],
    ['查询非字符串', { query: 5 }, false],
    ['未知键', { extra: true }, false],
  ]
  for (const [label, value, shouldPass] of cases) {
    const violations = violationsOf(host, V2_RECALL_TOOL_PARAMETERS, value)
    const passed = violations.length === 0
    record(
      `validate ${label}`,
      passed === shouldPass,
      passed === shouldPass
        ? ''
        : `期望${shouldPass ? '通过' : '拒绝'}，实际${passed ? '通过' : '拒绝'} ${violationText(violations)}`,
    )
  }

  // 3) 定义形状必须满足宿主 `ToolDefinition`（含必填的 output.schema/render）。
  const definition = createV2RecallTool({
    runtime: { recall: async () => ({ mode: 'ids', records: [], warnings: [] }) },
    sessionIdOf: () => 'probe-session',
  })
  const shapeProblems = []
  if (typeof definition.name !== 'string' || definition.name.length === 0) shapeProblems.push('name')
  if (typeof definition.description !== 'string' || definition.description.length === 0) shapeProblems.push('description')
  if (typeof definition.parameters !== 'object' || definition.parameters === null) shapeProblems.push('parameters')
  if (typeof definition.execute !== 'function') shapeProblems.push('execute')
  if (typeof definition.output?.schema !== 'object' || definition.output.schema === null) shapeProblems.push('output.schema')
  if (typeof definition.output?.render !== 'function') shapeProblems.push('output.render')
  record('ToolDefinition 形状', shapeProblems.length === 0, shapeProblems.join(', '))

  // 4) output.render 必须吐出宿主认识的 ContentBlock（这里只要 text 块）。
  try {
    const blocks = definition.output.render({}, { session_id: 'probe-session', mode: 'ids', records: [], warnings: [], budget_tokens: 1, used_tokens: 0 })
    const ok = Array.isArray(blocks)
      && blocks.length > 0
      && blocks.every((block) => block && block.type === 'text' && typeof block.text === 'string')
    record('output.render 返回 text ContentBlock', ok, ok ? '' : JSON.stringify(blocks))
  } catch (error) {
    record('output.render 返回 text ContentBlock', false, error instanceof Error ? error.message : String(error))
  }

  console.log(lines.join('\n'))
  console.log(failures.length === 0 ? 'PROBE: ALL PASS' : `PROBE: HAS FAILURES (${failures.join(', ')})`)
  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  if (staging) await rm(staging, { recursive: true, force: true })
}
