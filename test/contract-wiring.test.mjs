/**
 * P0-5（beta.9）契约接线静态守卫（Z-05/X-17 防再生）。
 *
 * 三道闸：
 * ① **导出即被消费**——src 下每个 .mjs 的 export 符号必须在 src 内有非定义处
 *    引用，或在白名单（每项附一行理由）。beta.8 审计实测 48 个 src 零引用导出；
 *    「导出了但没人用」的接线缺口（rememberRecall 一族）就是这么潜伏的。
 *    裸 throw 的错误契约闸在 v2-beta6-g2-error-contract.test.mjs（G2），不在此重复。
 * ② **单点孤儿标识符**——剥注释/字符串/正则后，全文恰出现一次、又不在声明位/
 *    导入/已知全局的标识符即候选（jobCap 类重命名漂移几乎必然单点存活：定义
 *    改名后旧名残留一处）。允许清单每项附理由；新出现的名字一律红。
 *    覆盖边界（诚实声明）：只钉「单点存活」类；多处引用的未定义名靠测试触达。
 * ③ 裸 throw 禁令见 G2 套件（本文件头部声明依赖关系，不复制判据）。
 *
 * 坏样本（M14）：revert-probe 场景 contract-wiring-dead-export /
 * contract-wiring-undefined-ref——向 src 注入死导出/未定义引用后本套件必红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function listSourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)))
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/**
 * 导出白名单：键 = 符号名，值 = 一行理由。新增条目必须写明「为什么不消费」；
 * 接线或删除后请把条目摘掉，白名单只缩不涨。
 */
const EXPORT_WHITELIST = new Map(Object.entries({
  Config: '宿主设置页入口（dsh-settings 读 fiber.runtime.Config 生成表单，消费方在宿主侧；src 内零消费是协议必然）；v3-surface-contract 锁「五个 volatile 字段 + ~standard 默认值」',
  _candidatesCacheStats: '测试钩子（B3-8）：v3-candidates-cache 套件锁「选择器不随历史长度线性变慢」的计数器，src 内零消费是设计',
  _resetCandidatesCacheStats: '测试钩子（B3-8）：v3-candidates-cache 套件复位计数用，src 内零消费是设计',
  // —— 测试钩子（*ForTest），生产不消费是设计而非缺口 ——  // —— P0-4 待逐个三选一（接线/删除/白名单定案），见进展卡-beta.9 ——  // —— v3 M0 骨架（dev-0.14.0/进展卡-M0）：M3 composition root 接线后逐项摘除 ——
  // —— 以下 5 项的「理由」于 0.15.0 收尾时按实测重写：原写法声称了并不存在的生产消费者 ——
  isV3Error: '**仅测试消费**：src 内唯一引用是 contracts/index.mjs 的 barrel re-export（re-export 不是调用）。生产错误判读一律走鸭子类型 error?.code ?? \'EINTERNAL\'（实测 src 内 instanceof V3ContractViolation 为 0 处）；v3-pressure-gate 套件锁信封形状',
  searchLexical: '**仅测试消费**：BM25 主路径在 t1-provider（打分不复用），生产没有降级分支调用它；v3-index-prototype / v3-vouchers-index 两个套件用它锁词元覆盖计数与确定性排序',
  rebuildLexicalIndex: '**仅测试消费**：注释里点名的「M3/M4 写路径维护点」至今未入驻，src 内零调用；v3-vouchers-index 套件用它锁「从记录完整重建」',
  gateRecallInjection: '**仅测试消费**：注释里点名的「M5 surface 执行层」消费者至今不存在，src 内除定义行外零引用；v3-slot-planner 套件锁回注闸（category=recall-injection）判据',
  textOfDshEvent: '**仅测试消费**：v3-entry 里它只是 extractEventBody(raw).text 的薄包装，自身零调用；生产消费点是内部 extractEventBody（v3-entry.mjs:2680）。8 个套件用它锁「content 数组 / 裸 text / 工具结果」三种形态',
  sliceByChars: 'P5：命中窗口不再按 UTF-16 切片，应用层唯一使用点被 selectExcerpt 取代；保留导出给 v3-t1-recall 锁代理对边界（码点纪律）',
  createFirstIngressRecordPort: 'P7 候选（默认关闭）：复用既有 tool/result 记录的端口，**当前 src 内零调用**（「未来 entry 接线」尚未发生）；v3-p7-records-adapter 锁真实 store 的查找/遗忘/导出/导入链'
}))

test('P0-5⓪：导出白名单只缩不涨，且每条理由必须成句', () => {
  // 「只缩不涨」此前只写在注释里，没有任何东西钉住它——注释不是守卫。
  // 这里钉死条目数：接线或删除后请**同步下调**下面的数字（下调是允许的，上涨必须解释）。
  assert.equal(EXPORT_WHITELIST.size, 10,
    '白名单条目数变了：' + [...EXPORT_WHITELIST.keys()].join('、') +
    '。新增条目必须先证明「为什么不消费」，并在本行显式上调数字；接线/删除后请下调。')
  for (const [name, reason] of EXPORT_WHITELIST) {
    assert.equal(typeof reason, 'string', name + ' 的白名单理由必须是字符串')
    assert.ok(reason.trim().length >= 12, name + ' 的白名单理由过短，必须写清「为什么不消费」')
  }
})

test('P0-5①：src 导出符号必须被 src 消费或在白名单（附理由）', async () => {
  const files = await listSourceFiles(SRC)
  const contents = new Map()
  for (const file of files) contents.set(file, await readFile(file, 'utf8'))
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const rel = (file) => path.relative(SRC, file).replaceAll('\\', '/')
  // 收集导出（定义行 + re-export 行）
  const exportsDef = new Map()
  for (const file of files) {
    const lines = contents.get(file).split('\n')
    for (const [i, line] of lines.entries()) {
      const plain = line.replace(/\r$/, '')
      let m = /^export (?:async )?function\*? (\w+)/.exec(plain)
        || /^export const (\w+)/.exec(plain)
        || /^export class (\w+)/.exec(plain)
      if (m) {
        if (!exportsDef.has(m[1])) exportsDef.set(m[1], new Set())
        exportsDef.get(m[1]).add(rel(file) + ':' + (i + 1))
        continue
      }
      m = /^export \{([^}]*)\}/.exec(plain)
      if (m) {
        for (const seg of m[1].split(',')) {
          const name = (seg.split(' as ').pop() ?? '').trim()
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
          if (!exportsDef.has(name)) exportsDef.set(name, new Set())
          exportsDef.get(name).add(rel(file) + ':' + (i + 1) + ' (re-export)')
        }
      }
    }
  }
  const offenders = []
  for (const [name, locs] of [...exportsDef.entries()].sort()) {
    if (EXPORT_WHITELIST.has(name)) continue
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')
    let refs = 0
    for (const file of files) refs += (stripComments(contents.get(file)).match(re) || []).length
    if (refs <= locs.size) offenders.push(name + '  ←  ' + [...locs].join(', '))
  }
  const unknownWhitelist = [...EXPORT_WHITELIST.keys()].filter((name) => !exportsDef.has(name))
  assert.deepEqual(unknownWhitelist, [], '白名单里有 src 已不存在的符号（请清理）：' + unknownWhitelist.join('、'))
  assert.deepEqual(offenders, [], '这些导出在 src 内零消费（接线、删除或写明白名单）：\n' + offenders.join('\n'))
})

// ② 单点孤儿标识符：剥注释/字符串/正则后全文恰出现一次的未声明名。
const KEYWORDS = new Set(('while for try catch class extends constructor async await function return if else throw new ' +
  'typeof instanceof delete continue break let const var void finally of in export import static switch case default ' +
  'do yield true false null from as get set this super debugger with').split(' '))
const GLOBALS = new Set(('Error TypeError RangeError SyntaxError Object Array JSON Math Number String Boolean Date Map Set ' +
  'WeakMap WeakSet Promise RegExp Symbol BigInt Buffer console process URL URLSearchParams TextEncoder TextDecoder ' +
  'AbortController AbortSignal structuredClone crypto setTimeout clearTimeout setInterval clearInterval setImmediate ' +
  'queueMicrotask performance fetch FormData Blob File CustomEvent Event EventTarget globalThis undefined NaN Infinity ' +
  'arguments encodeURIComponent decodeURIComponent atob btoa Intl parseFloat parseInt isNaN isFinite Reflect Proxy ' +
  'AggregateError ArrayBuffer DataView Uint8Array Int8Array Uint8ClampedArray Int16Array Uint16Array Int32Array ' +
  'Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array eval Function').split(' '))

/**
 * 孤儿允许清单：键 = 标识符，值 = 一行理由。这些名字只出现在不可strip的形态里
 * （嵌套模板散文、正则残渣），不是引用。新增真实代码触发的新名字**不在**清单里，
 * 会直接红。
 */
const ORPHAN_ALLOWLIST = new Map(Object.entries({
  // —— 正则字面量/转义残渣（剥除器的已知边界）——
  sha256: '正则/哈希名残渣',
  hex: '正则字符类残渣',
  utf8: '正则转义残渣',
  x2e80: '正则 \\x 转义残渣',
  _000: '数字分组正则残渣',
  _999_999: '数字分组正则残渣',
  _500: '数字分组正则残渣',
  _536: '数字分组正则残渣',
  _whole: '正则残渣',
  groups: 'query-plan 正则组名残渣',
  bjob: 'protection job-id 正则残渣',
  id: 'protection job-id 正则残渣',
  gi: '正则 flags 残渣',
  o600: '八进制字面量 0o600 被剥码器切出的词法残渣（B3-21 导出权限 0o600）',
  ID: '模板散文「记录 ID」',
  seq$: '模板散文 seq 前缀',
  // —— 字符串比较/枚举值在插值散文里的残渣 ——
  unknown: '回退文案枚举残渣',
  no: '回退文案枚举残渣',
  hint: '回退文案枚举残渣',
  missing: 'lingshu 缺失提示残渣',
  exclude: 'lingshu 查询参数残渣',
  literal: 'matchedBy 枚举残渣',
  semantic: 'matchedBy 枚举残渣',
  user: 'cancel 原因枚举残渣',
  cancel: 'cancel 原因枚举残渣',
  state: 'protection 正则残渣',
  done: 'protection 正则残渣',
  memory: '命令面前缀 /memory-lab 残渣',
  lab: '命令面前缀残渣',
  restore: '命令面/散文残渣',
  status: '命令面/散文残渣',
  ok: '模板散文完整性标记',
  string: 'typeof 比较散文',
  none: '模板散文占位',
  needs: 'fork 迁移散文',
  migration: 'fork 迁移散文',
  map: 'fork-map 形态名残渣',
  snapshots: 'cost 快照迭代',
  pairing: 'runtime-read 配对字段散文',
  budget_tokens: '模板散文预算名',
  memoryContextLabLifecycle: 'index 生成器声明（function* 未被声明位识别）',
  estimator: '模板散文「宿主 estimator 估算」',
  unpaired: 'working-state 模板散文（配对缺失描述）',
}))

test('P0-5②：剥注释后不存在单点存活的未定义标识符（jobCap 类潜伏 ReferenceError）', async () => {
  const files = await listSourceFiles(SRC)
  function stripCode(text) {
    let out = ''
    let i = 0
    const n = text.length
    const prevMeaningful = () => {
      for (let k = out.length - 1; k >= 0; k--) { const c = out[k]; if (c !== ' ' && c !== '\t' && c !== '\n') return c }
      return ''
    }
    while (i < n) {
      const ch = text[i]
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        out += text.slice(i, end < 0 ? n : end + 2).replace(/[^\n]/g, ' ')
        i = end < 0 ? n : end + 2
        continue
      }
      if (ch === '/' && text[i + 1] === '/') {
        let end = text.indexOf('\n', i); if (end < 0) end = n
        out += ' '.repeat(end - i); i = end; continue
      }
      if (ch === '\'' || ch === '"' || ch === '`') {
        const q = ch; let j = i + 1; out += q
        while (j < n) {
          if (text[j] === '\\') { out += '  '; j += 2; continue }
          if (q === '`' && text[j] === '$' && text[j + 1] === '{') {
            let depth = 1, k = j + 2; out += '${'
            while (k < n && depth > 0) { if (text[k] === '{') depth++; else if (text[k] === '}') { depth--; if (depth === 0) break } out += text[k]; k++ }
            out += '}'; j = k + 1; continue
          }
          if (text[j] === q) { out += q; j++; break }
          out += text[j] === '\n' ? '\n' : ' '; j++
        }
        i = j; continue
      }
      if (ch === '/') {
        const prev = prevMeaningful()
        if (prev === '' || '([{;,=:!&|?+-*%~^<>'.includes(prev) || out.endsWith('return ') || out.endsWith('case ')) {
          let j = i + 1, inClass = false
          while (j < n) {
            if (text[j] === '\\') { j += 2; continue }
            if (text[j] === '[') inClass = true
            else if (text[j] === ']') inClass = false
            else if (text[j] === '/' && !inClass) break
            else if (text[j] === '\n') break
            j++
          }
          if (j < n && text[j] === '/') {
            let k = j + 1
            while (k < n && /[gimsuyvd]/.test(text[k])) k++
            out += '/'.padEnd(k - i, ' ')
            i = k; continue
          }
        }
        out += ch; i++; continue
      }
      out += ch; i++
    }
    return out
  }
  const offenders = []
  for (const file of files) {
    const code = stripCode(await readFile(file, 'utf8'))
    const relFile = path.relative(SRC, file).replaceAll('\\', '/')
    const declared = new Set()
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
      for (const seg of m[1].split(',')) {
        const name = seg.split(':')[0].trim().replace(/^\.\.\./, '')
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
      }
    }
    for (const m of code.matchAll(/\{([^{}]*)\}/g)) {
      for (const seg of m[1].split(',')) {
        for (const part of seg.split(':')) {
          const name = part.trim().replace(/^\.\.\./, '')
          if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
        }
      }
    }
    for (const m of code.matchAll(/\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*/g)) declared.add(m[1])
    for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)(?:\s*,|\s+from)/g)) declared.add(m[1])
    for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
      for (const seg of m[1].split(',')) { const name = (seg.split(' as ')[0] ?? '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name) }
    }
    for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/(?:^|\n)\s*(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1])
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) declared.add(m[1])
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?=,|\}|\n)/g)) declared.add(m[1])
    const counts = new Map()
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)/g)) {
      const name = m[1]
      if (name.length <= 1) continue
      const before = code.slice(Math.max(0, m.index - 2), m.index)
      if (before.endsWith('.') || before.endsWith('?.')) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    for (const [name, count] of counts) {
      if (count !== 1) continue
      if (declared.has(name) || KEYWORDS.has(name) || GLOBALS.has(name) || ORPHAN_ALLOWLIST.has(name)) continue
      offenders.push(relFile + ' :: ' + name)
    }
  }
  assert.deepEqual(offenders, [], '这些标识符全文只出现一次且无声明（jobCap 类潜伏引用）：\n' + offenders.join('\n'))
})
