/**
 * 0.13.0 F8：插件消息不得冒充人类消息。
 *
 * 修复前插件写入的 user/message 一律 source.kind = 'user'，宿主侧所有按
 * kind === 'user' 取人类输入的功能都被污染。已取证的消费点（app.asar 核对）：
 *   - dsh-session-title：标题生成的 messageSeqs 含回执（实测 seq 162 是
 *     [31, 155, 157, 159]，后三条全是归档回执）；
 *   - dsh-session-turn-outline：轮次大纲用回执填「本轮提问」；
 *   - dsh-session-reference / dsh-web-deepseek-api：prompt 推导与引用面；
 *   - dsh-client-ui-chat：非 'user' 的 kind 渲染成 role:'inject'。
 *
 * dsh-session 的 user/message 不变量对 source.kind 无约束（lib/types/invariant.js
 * 里 case 'user/message': break;），所以改这个值不会让日志打不开。
 *
 * 兼容：旧日志仍是 kind:'user' + form，读取端按 form 识别，不依赖 kind。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isHumanAuthoredMessage,
  isPluginAuthoredMessage,
  PLUGIN_SOURCE_FORMS,
  PLUGIN_SOURCE_KIND,
} from '../src/core.mjs'

test('F8-1 插件消息的 kind 是包名，不是 user', () => {
  assert.equal(PLUGIN_SOURCE_KIND, 'dsh-memory-context-lab')
  assert.notEqual(PLUGIN_SOURCE_KIND, 'user')
})

test('F8-2 新形态（包名 + form）不被判为人类消息', () => {
  const message = {
    role: 'user',
    content: [{ type: 'text', text: '[已归档操作·v2] ...' }],
    source: { kind: PLUGIN_SOURCE_KIND, form: PLUGIN_SOURCE_FORMS.ARCHIVE_RECEIPT },
  }
  assert.equal(isHumanAuthoredMessage(message), false)
  assert.equal(isPluginAuthoredMessage(message), true)
})

test('F8-3 旧形态（user + form）仍被正确识别为插件消息（向后兼容）', () => {
  const legacy = {
    role: 'user',
    content: [{ type: 'text', text: '[已归档操作·v2] ...' }],
    source: { kind: 'user', form: PLUGIN_SOURCE_FORMS.ARCHIVE_RECEIPT },
  }
  assert.equal(isPluginAuthoredMessage(legacy), true)
  assert.equal(isHumanAuthoredMessage(legacy), false)
})

test('F8-4 真正的人类消息仍然被识别（修复不得顺手关掉人类判定）', () => {
  const human = {
    role: 'user',
    content: [{ type: 'text', text: '整理一下工作区' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }
  assert.equal(isHumanAuthoredMessage(human), true)
  assert.equal(isPluginAuthoredMessage(human), false)
})

test('F8-5 宿主注入的 runtime-context 快照不是人类消息', () => {
  const snapshot = {
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context...' }],
    source: { kind: 'runtime-context', form: 'snapshot' },
  }
  assert.equal(isHumanAuthoredMessage(snapshot), false)
})