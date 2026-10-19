/**
 * 0.13.1 守卫：域装配完整性（P4 拆分的回归防线）。
 *
 * ## 缺陷
 * 拆分后每个域是一个 `createXxxDomain({...})` 工厂，依赖靠参数表显式传入。
 * 两类装配错误**都不会被语法检查发现**，而且在测试里也可能走不到：
 * 1. **用了没声明**：函数体里引用了不在参数表里的名字 → 该分支一执行就
 *    ReferenceError（本轮实际发生过 4 处：auditInheritedArchive /
 *    retrievalStatusLines / indexCommand / recallTriggerOf）。
 * 2. **声明了没传**：参数表里有，但 runtime.mjs 的调用点漏传 → 值恒为
 *    undefined，静默降级（例如漏传 logger 就再也不会告警）。
 *
 * 实测确认：把 `semanticBackendStatus` / `semanticBackendFailure` 从参数表删掉，
 * 89 套件**全绿**——这两处 ReferenceError 在生产里才会炸。所以必须有静态守卫。
 *
 * ## 判据
 * - 每个 `runtime-*.mjs` 的工厂函数体内，自由标识符集合必须为空
 *   （参数 / import / 模块级声明 / JS 全局之外的名字）。
 * - 每个工厂的参数名，必须出现在 runtime.mjs 对应 `createXxxDomain({...})` 的调用里。
 *
 * ## 不适用条件与已知边界
 * 这是**文本分析**，不是 AST 分析：正则字面量、对象简写键、类方法名都会造成噪声，
 * 因此扫描前统一剥掉注释、字符串、模板字面量与正则字面量。它绿不等于逻辑正确，
 * 只等于「装配表对得上」。真正的行为正确性仍由各域自己的用例负责。
 *
 * ## 运行
 * `node --test-force-exit test/runtime-domain-wiring.test.mjs`；有缺口退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const V2 = path.join(SRC, 'v2')

const JS_GLOBALS = new Set((
  'undefined null true false this new typeof return if else for while await async function const let var of in try catch finally throw switch case break continue do delete void instanceof class extends super yield import export default static get set constructor as from'
  + ' Math JSON Object Array String Number Boolean Set Map WeakMap WeakSet Error Promise Date RegExp Infinity NaN parseInt parseFloat isNaN structuredClone Symbol BigInt Intl console process globalThis require module exports'
  + ' fetch setTimeout clearTimeout setInterval clearInterval queueMicrotask URL URLSearchParams TextEncoder TextDecoder Buffer AbortController AbortSignal ArrayBuffer Uint8Array Uint16Array Uint32Array Int32Array Float64Array encodeURIComponent decodeURIComponent btoa atob crypto performance'
  + ' RangeError TypeError SyntaxError ReferenceError AggregateError'
).split(/\s+/).filter(Boolean))

const QUOTE = String.fromCharCode(39)
const BACKTICK = String.fromCharCode(96)

/**
 * 剥掉注释、字符串、模板字面量的**文本部分**与正则字面量，只留结构骨架。
 *
 * 逐字符扫描而不是用正则：模板字面量可以嵌套（`${items.map((x) => `seq${x}`)}`），
 * 正则替换会把嵌套部分一起吞掉，反而让真正的自由变量漏检。模板里的 `${...}`
 * 是**代码**，必须保留。
 */
function skeleton(text) {
  const out = []
  const stack = [] // 'tmpl' | 'brace'
  let prev = '' // 上一个有效字符，用来判断 / 是除号还是正则开头
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const next = text[i + 1]
    const inTemplateText = stack.length > 0 && stack[stack.length - 1] === 'tmpl'
    if (inTemplateText) {
      if (c === '\\') { i += 1; continue }
      if (c === String.fromCharCode(96)) { stack.pop(); continue }
      if (c === '$' && next === '{') { stack.push('brace'); i += 1; out.push(' '); continue }
      continue
    }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out.push(' '); continue }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; out.push(' '); continue }
    if (c === String.fromCharCode(39) || c === '"') {
      const quote = c
      i += 1
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue } if (text[i] === quote) break; i += 1 }
      out.push(' ')
      prev = quote
      continue
    }
    if (c === String.fromCharCode(96)) { stack.push('tmpl'); out.push(' '); prev = c; continue }
    if (c === '{' && stack.length > 0 && stack[stack.length - 1] === 'brace') { stack.push('brace'); out.push('{'); prev = c; continue }
    if (c === '}') {
      if (stack.length > 0 && stack[stack.length - 1] === 'brace') { stack.pop(); if (stack.length > 0 && stack[stack.length - 1] === 'tmpl') { out.push(' '); prev = c; continue } }
      out.push('}'); prev = c; continue
    }
    if (c === '/') {
      const regexAllowed = prev === '' || /[=(,:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(?:return|typeof|case|in|of)$/.test(out.join('').slice(-12))
      if (regexAllowed) {
        i += 1
        let inClass = false
        while (i < text.length) {
          const ch = text[i]
          if (ch === '\\') { i += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) break
          else if (ch === '\n') break
          i += 1
        }
        while (i + 1 < text.length && /[gimsuy]/.test(text[i + 1])) i += 1
        out.push(' ')
        prev = '/'
        continue
      }
    }
    out.push(c)
    if (!/\s/.test(c)) prev = c
  }
  return out.join('')
}
function namesOf(chunk) {
  const set = new Set()
  for (const m of chunk.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) set.add(m[0])
  return set
}

function balanced(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i }
  }
  return -1
}

async function loadDomains() {
  const files = (await readdir(V2)).filter((f) => f.startsWith('runtime-') && f.endsWith('.mjs'))
  const out = []
  for (const file of files.sort()) {
    const raw = await readFile(path.join(V2, file), 'utf8')
    const code = skeleton(raw)
    const match = /export function (create[A-Za-z0-9_$]*)\s*\(/.exec(code)
    if (!match) continue
    const openIdx = code.indexOf('(', match.index)
    const closeIdx = balanced(code, openIdx)
    assert.ok(closeIdx > openIdx, file + ' 的参数表无法配对')
    const params = namesOf(code.slice(openIdx + 1, closeIdx))
    const body = code.slice(closeIdx + 1)
    out.push({ file, factory: match[1], params, body, raw })
  }
  return out
}

test('量具自检：真的找到了域工厂', async () => {
  const domains = await loadDomains()
  assert.ok(domains.length >= 9, '只找到 ' + domains.length + ' 个域工厂，扫描器可能失效')
  assert.ok(domains.some((d) => d.factory === 'createLifecycleDomain'))
  assert.ok(domains.some((d) => d.factory === 'createRecallDomain'))
})

test('每个域的函数体不得引用参数表之外的名字（用了没声明）', async () => {
  const domains = await loadDomains()
  const problems = []
  for (const d of domains) {
    const declared = new Set([...d.params])
    for (const m of d.raw.matchAll(/^import\s+(?:([A-Za-z0-9_$]+)|\{([\s\S]*?)\}|\*\s+as\s+([A-Za-z0-9_$]+))\s+from/gm)) {
      if (m[1]) declared.add(m[1])
      if (m[3]) declared.add(m[3])
      if (m[2]) m[2].split(',').forEach((s) => { const n = s.split(' as ').pop().trim(); if (n) declared.add(n) })
    }
    const factoryIdx = d.body.indexOf('}') 
    const head = d.raw.slice(0, d.raw.search(/export function create[A-Za-z0-9_$]*\s*\(/))
    for (const m of skeleton(head).matchAll(/\b(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1])
    const body = d.body
    for (const m of body.matchAll(/\b(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1])
    for (const m of body.matchAll(/\bfunction\s*[A-Za-z0-9_$]*\s*\(([^()]*)\)/g)) for (const n of namesOf(m[1])) declared.add(n)
    for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) for (const n of namesOf(m[1])) declared.add(n)
    for (const m of body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) declared.add(m[1])
    for (const m of body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1])
    for (const m of body.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1])
    for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of namesOf(m[1])) declared.add(n)
    for (const m of body.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const n of namesOf(m[1])) declared.add(n)
    const memberish = new Set()
    for (const m of body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) memberish.add(m[1])
    for (const m of body.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) memberish.add(m[1])
    for (const m of body.matchAll(/\?\.[\s]*([A-Za-z_$][A-Za-z0-9_$]*)/g)) memberish.add(m[1])
    const free = []
    for (const m of body.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      const id = m[2]
      if (JS_GLOBALS.has(id) || declared.has(id) || memberish.has(id)) continue
      if (!free.includes(id)) free.push(id)
    }
    if (free.length) problems.push(d.file + ': ' + free.sort().join(' '))
  }
  assert.deepEqual(problems, [], '域内出现未声明的名字（执行到该分支即 ReferenceError）：\n' + problems.join('\n'))
})

test('每个域的参数都必须由 runtime.mjs 的调用点传入（声明了没传）', async () => {
  const domains = await loadDomains()
  const runtime = skeleton(await readFile(path.join(V2, 'runtime.mjs'), 'utf8'))
  const problems = []
  for (const d of domains) {
    const callIdx = runtime.indexOf(d.factory + '(')
    if (callIdx < 0) { problems.push(d.file + ': runtime.mjs 从未调用 ' + d.factory); continue }
    const openIdx = runtime.indexOf('(', callIdx)
    const closeIdx = balanced(runtime, openIdx)
    const passed = namesOf(runtime.slice(openIdx + 1, closeIdx))
    const missing = [...d.params].filter((n) => !passed.has(n))
    if (missing.length) problems.push(d.file + ' → ' + d.factory + ' 漏传: ' + missing.sort().join(' '))
  }
  assert.deepEqual(problems, [], '装配表缺项：\n' + problems.join('\n'))
})
