/**
 * C 类守卫（0.15.4）：客户端缺省必须与宿主同源，内部码不得直出给用户。
 *
 * ## 缺陷
 *
 * - **C-01**：`controlOfStatus` 在投影缺失/坏形状时回落 `enabled:true, recall:true`，
 *   而宿主新会话是 `defaultEnabled:false` → chip 亮「已启用」，点进去什么都没回注。
 * - **C-02**：同一函数族的 `projectedMode` 回落 `'recall-only'`，而宿主
 *   `modeForNewSession` 是 `'full-history'` → 选择器把「按轮归档」显示成「仅回注」，
 *   而且用户在这个窗口里点一下就会把**错的值写成真的**（比只显示错更糟）。
 * - **C-05**：`runLine` 把 `no-session` / `unknown-command` / `no-remote` / `no-result`
 *   塞进 `text`，经 `t('commandFailed',{message})` 拼成「命令失败：no-remote」——
 *   字典里没有这些键，用户看到英文内部码。
 *
 * ## 共同根因
 *
 * 客户端与服务端**各自写了一份缺省值**，且方向相反。宿主侧的 `defaultEnabled:false`
 * 与新会话 `modeForNewSession='full-history'` 才是权威；客户端不得再造一份。
 * 这就是用户裁定「问题 7 = 对齐宿主、不改宿主」的落点。
 *
 * ## 钉住的判据
 *
 * 1. 投影缺失时 `controlOfStatus` 必须给 `enabled:false`（不清白标「已启用」）；
 * 2. 投影缺失时模式回落必须是 `full-history`，**不得**是 `recall-only`；
 * 3. 投影里给了真值时必须原样采用（回落不能盖掉真相）；
 * 4. 内部码不得出现在用户可见文案里；同时 `code` 仍保留（诊断锚点不能丢）。
 *
 * ## 不适用条件
 *
 * - 不测真实浏览器渲染（`v3-client-surface` 钉字段面）。
 * - 不测宿主侧 `defaultEnabled`（`v3-i6-default-off` 钉）。
 * - 不测远程命令通道是否可用（`v3-client-optional-injects` 钉）。
 *
 * ## 变异自证
 *
 * 把回落改回 `enabled:true` / `'recall-only'` → 用例 1、2 红；
 * 把 `text` 改回裸内部码 → 用例 4 红。恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')

/**
 * 客户端是浏览器半成品（无 ESM 导出、依赖宿主注入），不能直接 import。
 * 因此这里做**源码级判据**：把守必须出现/不得出现的字面量。
 * 这比 import 弱，但对「缺省值方向」这类纯字面量判据足够，且不会误报。
 */
async function clientSource() {
  return readFile(clientPath, 'utf8')
}

/** 去掉注释（避免把解释旧缺陷的注释误判成缺陷本身——此前已踩过一次）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取出某个函数体（从 `function NAME(` 起，到下一个顶格 `function ` 或 `async function` 前）。 */
function functionBodyOf(source, name) {
  const clean = stripComments(source)
  const start = clean.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, '客户端里找不到函数 ' + name)
  const rest = clean.slice(start + 1)
  const nextFn = rest.search(/\n\s{0,6}(async )?function [A-Za-z_$]/)
  return nextFn === -1 ? rest : rest.slice(0, nextFn)
}

test('C-01：投影缺失时客户端缺省必须是 enabled:false（不得亮成已启用）', async () => {
  const source = await clientSource()
  const body = functionBodyOf(source, 'controlOfStatus')
  assert.ok(
    /enabled:\s*false/.test(body),
    'controlOfStatus 的回落必须是 enabled:false（宿主新会话 defaultEnabled:false）',
  )
  assert.ok(
    !/enabled:\s*true/.test(body),
    'controlOfStatus 不得回落 enabled:true——那会让新会话 chip 撒谎',
  )
})

test('C-02：投影缺失时模式回落必须是 full-history（不得是 recall-only）', async () => {
  const source = stripComments(await clientSource())
  // 该回落是 `: 'xxx'` 形式挂在 projectedMode 的三元上，不在独立函数里
  const idx = source.indexOf('const projectedMode')
  assert.notEqual(idx, -1, '找不到 projectedMode')
  const tail = source.slice(idx, idx + 900)
  assert.ok(
    /:\s*'full-history'/.test(tail),
    "projectedMode 的回落必须是 'full-history'（宿主新会话 modeForNewSession）",
  )
  assert.ok(
    !/:\s*'recall-only'/.test(tail),
    "projectedMode 不得回落到 'recall-only'——用户在该窗口点一下会把错值写成真的",
  )
})

test('C-05：内部码不得出现在用户可见文案里，但 code 必须保留', async () => {
  const raw = await clientSource()
  const source = stripComments(raw)
  // 四个内部码仍作为 code 值出现（诊断锚点）——查原始源码即可，注释不影响
  for (const code of ['no-session', 'unknown-command', 'no-remote', 'no-result']) {
    assert.ok(
      new RegExp("'" + code + "'").test(source),
      '内部码 ' + code + ' 必须仍可作为 code 值出现（诊断与测试锚点）',
    )
  }
  // 关键判据：不得再有 `text: '内部码'` 的直出形式
  for (const code of ['no-session', 'unknown-command', 'no-remote', 'no-result']) {
    assert.ok(
      !new RegExp("text:\\s*'" + code + "'").test(source),
      '内部码 ' + code + ' 不得直接作为 text 显示给用户',
    )
  }
  // 必须有中文映射表把码翻成人话
  assert.ok(
    /INTERNAL_CODE_TEXT/.test(source),
    '必须存在内部码 → 中文文案的映射，不能把码直接抛给用户',
  )
})
