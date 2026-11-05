/**
 * I1 T2 cg 调用面静态守卫。
 *
 * 判据为静态词法扫描；本守卫采用下述白名单并明确记录其限制边界。
 *
 * 本守卫是静态源码调用面审查，采用白名单式判据：client 只允许访问 callTool/close/start/stderrOf；
 * 任何首参为字面量 'cg' 的多参调用必须以 .callTool 结尾；callTool 的 op 只允许 read/write/forget。
 * 调用点 args 只允许声明一次且初始化来自 externalSearchArgsOf（helper 内部 args 由 helper 规则单独校验）。
 * 另拒绝动态执行（eval/Function/constructor 链）、反射提取（Reflect/getOwnProperty* / Object.keys/values/entries/assign）、
 * 全局对象别名（globalThis/global/window/self）、解构别名、模板插值、call/apply/bind 分发、for-in 枚举。
 * 本守卫通过静态词法约束实现，不追踪任意变量的数据流。若未来引入新的间接传参形态（如把 args 存入对象再取出），
 * 本守卫应以「无法证明安全」而非「证明不安全」失败；此时改用 AST 分析，而非继续追加词法规则。
 * 它不承诺对抗任意动态反射、运行时注入或 AST 级重构——那需要沙箱或 AST 隔离，超出本守卫职责。
 * 守卫的价值是防止误用与明显越界，不是证明代码不可能越界。
 * 本守卫的判据到此为止。若未来出现需 AST 分析才能封闭的形态，记录为已知限制，不继续追加黑名单式规则。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const adapterDir = path.resolve(here, '../src/v3/adapters/retrieval')
const ALLOWED_OPS = new Set(['read', 'write', 'forget'])

function stripComments(source) {
  // Preserve quoted strings/templates; remove only JS comments to avoid matching examples in comments.
  let out = ''
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1 }
      if (i < source.length) out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < source.length) { out += '  '; i += 1 }
      continue
    }
    out += ch
  }
  return out
}

function splitTopLevel(text, separator = ',') {
  const parts = []
  let start = 0
  let quote = ''
  let escaped = false
  const stack = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (pairs[ch]) {
      assert.equal(stack.pop(), pairs[ch], '括号结构必须平衡')
    } else if (ch === separator && stack.length === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  assert.equal(stack.length, 0, '调用参数括号必须闭合')
  parts.push(text.slice(start).trim())
  return parts
}

function matchingParen(text, openAt) {
  let quote = ''
  let escaped = false
  let depth = 0
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  assert.fail('callTool 调用缺少闭合括号')
}

function literalOpFromObject(expression, label) {
  assert.ok(expression.startsWith('{') && expression.endsWith('}'), label + ': 参数必须是对象字面量')
  const fields = splitTopLevel(expression.slice(1, -1))
  if (fields.at(-1) === '') fields.pop() // trailing commas are valid object syntax
  assert.ok(fields.length > 0 && fields.every((field) => field.length > 0), label + ': 不允许空字段')
  assert.ok(fields.every((field) => !field.startsWith('...')), label + ': 不允许对象展开/动态覆盖')
  const opFields = fields.filter((field) => /^op\s*:/.test(field))
  assert.equal(opFields.length, 1, label + ': 必须且只能有一个顶层 op 字段')
  const match = opFields[0].match(/^op\s*:\s*(['"])([^'"]+)\1$/)
  assert.ok(match, label + ': op 必须是字符串字面量')
  assert.ok(ALLOWED_OPS.has(match[2]), label + ': 禁止的 cg op=' + match[2])
  return match[2]
}

function assertReadArgsBuilder(source, label) {
  const clean = stripComments(source)
  const declaration = clean.match(/function\s+externalSearchArgsOf\s*\([^)]*\)\s*\{/)
  assert.ok(declaration, label + ': 缺少受约束的 externalSearchArgsOf 构造器')
  const openAt = declaration.index + declaration[0].lastIndexOf('{')
  let depth = 0
  let closeAt = -1
  for (let i = openAt; i < clean.length; i += 1) {
    if (clean[i] === '{') depth += 1
    else if (clean[i] === '}') { depth -= 1; if (depth === 0) { closeAt = i; break } }
  }
  assert.ok(closeAt > openAt, label + ': helper 函数体必须闭合')
  const body = clean.slice(openAt + 1, closeAt)
  assert.equal([...body.matchAll(/\b(?:const|let|var)\s+args\b/g)].length, 1, label + ': helper 内部 args 只允许声明一次')
  assert.match(body, /const\s+args\s*=\s*\{\s*op\s*:\s*'read'/, label + ': helper 必须以静态 read 构造 args')
  assert.match(body, /return\s+args\s*;?/, label + ': helper 必须返回该 args')
  assert.doesNotMatch(body, /(?:args\s*\.\s*op|args\s*\[\s*['"]op['"]\s*\])\s*=/, label + ': helper 不得改写 op')
}

function maskStringLiterals(source) {
  let out = ''
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      out += ch === '\n' ? '\n' : ' '
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; out += ' '; continue }
    out += ch
  }
  return out
}

function findExternalSearchArgsBuilderRange(source) {
  const declaration = source.match(/\bfunction\s+externalSearchArgsOf\s*\([^)]*\)\s*\{/)
  if (!declaration) return null
  const openAt = declaration.index + declaration[0].lastIndexOf('{')
  let depth = 0
  for (let i = openAt; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { start: openAt, end: i + 1 }
    }
  }
  return null
}

function assertArgsAssignmentSources(source, label) {
  const clean = maskStringLiterals(stripComments(source))
  const builderRange = findExternalSearchArgsBuilderRange(clean)
  if (builderRange) assertReadArgsBuilder(source, label)

  let callSiteDeclarations = 0
  const allowedInitializerPositions = new Set()
  const declarationRe = /\b(?:const|let|var)\s+args\b/g
  let declaration
  while ((declaration = declarationRe.exec(clean)) !== null) {
    const argsAt = declaration.index + declaration[0].lastIndexOf('args')
    if (builderRange && argsAt >= builderRange.start && argsAt < builderRange.end) continue
    let rhsAt = declarationRe.lastIndex
    while (/\s/.test(clean[rhsAt] ?? '')) rhsAt += 1
    assert.equal(clean[rhsAt], '=', label + ': args 必须初始化且不能只有声明')
    rhsAt += 1
    while (/\s/.test(clean[rhsAt] ?? '')) rhsAt += 1
    assert.match(clean.slice(rhsAt), /^externalSearchArgsOf\s*\(/, label + ': args 初始化必须来自 externalSearchArgsOf(...)')
    callSiteDeclarations += 1
    allowedInitializerPositions.add(argsAt)
  }
  assert.ok(callSiteDeclarations <= 1, label + ': args 调用点只允许声明一次')
  const outsideArgsUses = [...clean.matchAll(/\bargs\b/g)].filter((match) => !builderRange || match.index < builderRange.start || match.index >= builderRange.end).length
  assert.ok(outsideArgsUses === 0 || callSiteDeclarations === 1, label + ': args 调用点使用必须有唯一受约束的声明')

  const assignmentRe = /\bargs\b\s*(?:(?:\.\s*[A-Za-z_$][\w$]*)|(?:\[\s*[^\]]*\]))?\s*(?:=(?!=|>)|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|\?\?=|&&=|\|\|=|\+\+|--)/g
  let assignment
  while ((assignment = assignmentRe.exec(clean)) !== null) {
    if (builderRange && assignment.index >= builderRange.start && assignment.index < builderRange.end) continue
    if (allowedInitializerPositions.has(assignment.index)) continue
    assert.fail(label + ': 不允许 args 重新赋值或修改属性')
  }
  assert.doesNotMatch(clean, /(?:\+\+|--)\s*args\b/, label + ': 不允许递增/递减 args')
}

function hasTemplateInterpolation(source) {
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch !== String.fromCharCode(96)) continue

    let closed = false
    for (let j = i + 1; j < source.length; j += 1) {
      if (source[j] === '\\') { j += 1; continue }
      if (source[j] === String.fromCharCode(96)) { i = j; closed = true; break }
      if (source[j] === '$' && source[j + 1] === '{') return true
    }
    if (!closed) return true // malformed template: fail closed
  }
  return false
}

function hasComputedMemberCall(source) {
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue }
    if (ch !== '[') continue

    let previous = i - 1
    while (previous >= 0 && /\s/.test(source[previous])) previous -= 1
    if (source[previous] === '.' && source[previous - 1] === '?') previous -= 2
    const receiver = source[previous]
    if (!/[\w$)\]]/.test(receiver ?? '')) continue

    let depth = 1
    let innerQuote = ''
    let innerEscaped = false
    let end = i + 1
    for (; end < source.length && depth > 0; end += 1) {
      const current = source[end]
      if (innerQuote) {
        if (innerEscaped) innerEscaped = false
        else if (current === '\\') innerEscaped = true
        else if (current === innerQuote) innerQuote = ''
        continue
      }
      if (current === "'" || current === '"' || current.charCodeAt(0) === 96) { innerQuote = current; continue }
      if (current === '[') depth += 1
      else if (current === ']') depth -= 1
    }
    if (depth !== 0) return true // malformed/unparseable computed member: fail closed
    while (end < source.length && /\s/.test(source[end])) end += 1
    if (source.slice(end, end + 2) === '?.') {
      end += 2
      while (end < source.length && /\s/.test(source[end])) end += 1
    }
    if (source[end] === '(') return true
  }
  return false
}

function hasDynamicCodeIdentifier(source) {
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue }
    if (!/[A-Za-z_$]/.test(ch)) continue
    let end = i + 1
    while (end < source.length && /[\w$]/.test(source[end])) end += 1
    const identifier = source.slice(i, end)
    if (['eval', 'Function', 'constructor', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols'].includes(identifier)) return true
    i = end - 1
  }
  return false
}

function assertClientMemberAccesses(source, label) {
  const allowed = new Set(['callTool', 'close', 'start', 'stderrOf'])
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue }
    if (source.slice(i, i + 6) !== 'client') continue
    if (/[\w$]/.test(source[i - 1] ?? '') || /[\w$]/.test(source[i + 6] ?? '')) continue
    let memberAt = i + 6
    while (/\s/.test(source[memberAt] ?? '')) memberAt += 1
    if (source[memberAt] === '[') assert.fail(label + ': client 不允许计算属性访问')
    if (source.slice(memberAt, memberAt + 2) === '?.') memberAt += 2
    else if (source[memberAt] === '.') memberAt += 1
    else continue
    while (/\s/.test(source[memberAt] ?? '')) memberAt += 1
    const member = source.slice(memberAt).match(/^[A-Za-z_$][\w$]*/)?.[0]
    assert.ok(member && allowed.has(member), label + ': client 成员只允许 callTool/close/start/stderrOf')
    i += 5
  }
}

function assertCgCallersUseCallTool(source, label) {
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue }
    if (ch !== '(' || !/^\s*'cg'\s*,/.test(source.slice(i + 1))) continue
    const closeAt = matchingParen(source, i)
    const args = splitTopLevel(source.slice(i + 1, closeAt))
    if (args.length < 2 || args[1] === '') continue // a trailing comma is not a second argument
    const callee = source.slice(0, i).trimEnd()
    assert.match(callee, /\.\s*callTool$/, label + ': 首参为 cg 的多参调用必须由 .callTool 发起')
  }
}

function assertClosedCallSyntax(clean, label) {
  // This probe and provider use a bounded client member surface and caller allowlist.
  assertClientMemberAccesses(clean, label)
  assertArgsAssignmentSources(clean, label)
  assertCgCallersUseCallTool(clean, label)
  assert.doesNotMatch(clean, /\b(?:globalThis|global|window|self)\b/, label + ': 不允许全局对象访问/别名')
  assert.doesNotMatch(clean, /\.\s*(?:call|apply|bind)\s*\(/, label + ': 不允许 Function.call/apply/bind 分发')
  assert.doesNotMatch(clean, /\bReflect\b/, label + ': 不允许 Reflect 反射分发或别名')
  assert.doesNotMatch(clean, /\bObject\s*\.\s*keys\b|\bObject\s*\[/, label + ': 不允许 Object.keys 或 Object 计算属性反射')
  assert.doesNotMatch(clean, /\bObject\s*\.\s*(?:values|entries|assign)\b/, label + ': 不允许通过 Object 枚举/复制函数引用')
  assert.doesNotMatch(clean, /\bfor\s*\([^)]*\bin\b/, label + ': 不允许 for-in 枚举对象属性')
  assert.doesNotMatch(clean, /\b(?:const|let|var)\s+\w+\s*=\s*Object\s*(?:;|,|\n)/, label + ': 不允许 Object 别名')
  assert.equal(hasDynamicCodeIdentifier(clean), false, label + ': 不允许 eval/Function/reflection 动态执行')
  assert.equal(hasTemplateInterpolation(clean), false, label + ': 不允许模板插值，需先显式审查语法')
  assert.equal(hasComputedMemberCall(clean), false, label + ': 不允许计算属性调用')
  assert.doesNotMatch(clean, /\b(?:const|let|var)\s+\w+\s*=\s*\(?\s*client\s*(?:;|,|\n)/, label + ': 不允许 client 别名')
  assert.doesNotMatch(clean, /\b(?:const|let|var)\s*\{[^}]*\}\s*=/, label + ': 不允许解构变量声明')
  assert.doesNotMatch(clean, /\(\s*\{[^}]*\}\s*=\s*[A-Za-z_$][\w$]*\s*\)/, label + ': 不允许对象解构赋值提取')
  const withoutTypeCheck = clean.replace(/\btypeof\s+\w+\s*\.\s*callTool\s*!==?\s*['"]function['"]/g, '')
  assert.doesNotMatch(withoutTypeCheck, /\.\s*callTool\b(?!\s*\()/, label + ': 不允许提取/别名化 callTool 方法')
  assert.doesNotMatch(clean, /\[\s*(?:['"]callTool['"]|['"]call['"]\s*\+\s*['"]Tool['"]|\x60[^\x60]*call[^\x60]*\x60)\s*\]/, label + ': 不允许拼接或模板计算 callTool 属性')
}


function scanCgCalls(source, label) {
  const clean = stripComments(source)
  assertClosedCallSyntax(clean, label)
  const callRe = /\bcallTool\s*\(/g
  const operations = []
  let match
  while ((match = callRe.exec(clean)) !== null) {
    const openAt = clean.indexOf('(', match.index)
    const closeAt = matchingParen(clean, openAt)
    const args = splitTopLevel(clean.slice(openAt + 1, closeAt))
    assert.ok(args.length >= 2, label + ': callTool 必须有工具名和参数')
    assert.equal(args[0], "'cg'", label + ': 工具名必须是字面量 cg')
    let op
    if (args[1] === 'args') {
      assertReadArgsBuilder(clean, label)
      op = 'read'
    } else {
      op = literalOpFromObject(args[1], label + ' callTool#' + (operations.length + 1))
    }
    operations.push(op)
    callRe.lastIndex = closeAt + 1
  }
  assert.ok(operations.length > 0, label + ': 必须扫描到真实 callTool 调用点')
  return operations
}

function assertSurfaceSafe(source, label) {
  return scanCgCalls(source, label)
}

test('当前 provider 与 probe 仅调用 cg read/write/forget', () => {
  const provider = readFileSync(path.join(adapterDir, 't2-isolated-provider.mjs'), 'utf8')
  const probe = readFileSync(path.join(adapterDir, 't2-probe.mjs'), 'utf8')
  const providerOps = assertSurfaceSafe(provider, 't2-isolated-provider.mjs')
  const probeOps = assertSurfaceSafe(probe, 't2-probe.mjs')
  assert.ok(providerOps.includes('read') && providerOps.includes('write') && providerOps.includes('forget'))
  assert.ok(probeOps.includes('read') && probeOps.includes('write') && probeOps.includes('forget'))
})

test('内存反例：scrub、maintain、第四种 op 与动态绕过必须失败', () => {
  for (const forbidden of ['scrub', 'maintain', 'recent']) {
    const injected = "await client.callTool('cg', { op: '" + forbidden + "' })"
    assert.throws(() => assertSurfaceSafe(injected, 'mutation ' + forbidden), /禁止的 cg op/)
  }
  assert.throws(
    () => assertSurfaceSafe("await client.callTool('cg', { op: selectedOp })", 'dynamic op'),
    /op 必须是字符串字面量/,
  )
  assert.throws(
    () => assertSurfaceSafe("await client.callTool('cg', { op: 'read', ...untrustedArgs })", 'spread'),
    /不允许对象展开/,
  )
  assert.throws(
    () => assertSurfaceSafe("await client.callTool(toolName, { op: 'read' })", 'dynamic tool'),
    /工具名必须是字面量 cg/,
  )
  for (const [name, bypass] of [
    ['Function.call', "client.callTool.call(client, 'cg', { op: 'scrub' })"],
    ['Function.apply', "client.callTool.apply(client, ['cg', { op: 'maintain' }])"],
    ['computed concat', "client['call' + 'Tool']('cg', { op: 'scrub' })"],
    ['computed template', "client[ `call${'Tool'}` ]('cg', { op: 'maintain' })"],
    ['Reflect.apply', "Reflect.apply(client.callTool, client, ['cg', { op: 'scrub' }])"],
    ['extracted alias', "const invoke = client.callTool; invoke('cg', { op: 'scrub' })"],
  ]) {
    assert.throws(() => assertSurfaceSafe(bypass, name), /不允许|callTool|Reflect/ , name + ' must be rejected')
  }
  const provider = readFileSync(path.join(adapterDir, 't2-isolated-provider.mjs'), 'utf8')
  const probe = readFileSync(path.join(adapterDir, 't2-probe.mjs'), 'utf8')
  for (const source of [provider, probe]) {
    for (const extraction of [
      "const { callTool: invoke } = client; invoke('cg', { op: 'scrub' })",
      "const { callTool } = client; callTool('cg', { op: 'maintain' })",
      "let invoke; ({ callTool: invoke } = client); invoke('cg', { op: 'scrub' })",
      "let callTool; ({ callTool } = client); callTool('cg', { op: 'maintain' })",
      "let invoke; ({ ['callTool']: invoke } = client); invoke('cg', { op: 'scrub' })",
      "let invoke; ({ ['call' + 'Tool']: invoke } = client); invoke('cg', { op: 'maintain' })",
      "client?.[key]('cg', { op: 'scrub' })",
      "const c = client; c[key]('cg', { op: 'maintain' })",
      "const x = `${client[key]('cg',{op:'scrub'})}`",
      "const c = client; const x = `${c[key]('cg',{op:'scrub'})}`",
      "eval(\"client[key]('cg',{op:'scrub'})\")",
      "new Function(\"return client[key]('cg',{op:'scrub'})\")()",
      "client.constructor.constructor(\"c\", \"return c[key]('cg',{op:'scrub'})\")(client)",
      "Object.getOwnPropertyDescriptor(client, 'callTool').value('cg',{op:'scrub'})",
      "Object.getOwnPropertyDescriptors(client).callTool.value('cg',{op:'scrub'})",
      "Object.getOwnPropertyNames(client).filter((name) => name === 'callTool')",
      "Object.keys(client)",
      "Object.values(client).at(1)('cg', { op: 'scrub' })",
      "Object.entries(client).find(([name]) => name === 'callTool').at(1)('cg',{op:'scrub'})",
      "globalThis['Object'].values(client).at(1)('cg', { op: 'scrub' })",
      "const O = globalThis.Object; O.values(client).at(1)('cg', { op: 'scrub' })",
      "const methodKey = 'callTool'; const extracted = client[methodKey]; extracted('cg', { op: 'scrub' })",
      "function bypass(client) { const args = { op: 'scrub' }; return client.callTool('cg', args) }",
      "Object.assign({}, client).callTool('cg', { op: 'scrub' })",
      "for (const key in client) { const fn = client[key]; fn('cg', { op: 'scrub' }) }",
    ]) {
      assert.throws(
        () => assertSurfaceSafe(source + '\n' + extraction, 'source destructuring'),
        /不允许|Reflect|必须由 .callTool|client 成员|args/,
      )
    }
  }
  assert.throws(
    () => assertSurfaceSafe(provider.replace("const args = { op: 'read'", "const args = { op: 'scrub'"), 'builder mutation'),
    /必须以静态 read 构造 args/,
  )
})
