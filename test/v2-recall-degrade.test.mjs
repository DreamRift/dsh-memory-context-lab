/**
 * 回归测试：自动回注的查询是**整条人类消息**（最长 800 字符），
 * 多词 AND 对它不可满足 —— 实测 12/12 只命中查询记录自身，
 * 而生产场景下当前人类消息尚未归档、其自身记录不存在 ⇒ 恒 0 命中。
 *
 * 契约（不得违反）：
 *   - T1 后端自身的多词 AND 语义（`v2-local-lexical.test.mjs:80` 锁着）不改；
 *   - 修复落在查询路径：整条查询无命中时**降级为部分匹配 + 打分排序**，
 *     并且必须如实报告这次降级，不得把部分匹配伪装成精确命中；
 *   - 短关键词查询走原有精确路径，行为不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { searchRecords, RETRIEVAL_SOURCES } from '../src/v2/retrieval.mjs'

async function newDir() {
  return mkdtemp(path.join(tmpdir(), 'retrieval-degrade-'))
}

/** 最小 store 替身：只实现 searchRecords 用到的 three 个方法。 */
function makeStore(entries, directory) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  return {
    directory,
    getEntry: (id) => byId.get(id),
    listEntries: () => ({ entries }),
  }
}

/** 一个「索引了正文」的假后端，复刻 T1 的多词 AND 语义。 */
function makeAndBackend(docs) {
  return {
    name: 'fake-and-lexical',
    capabilities: { kind: 'lexical-structural', semanticVectors: false },
    async index() { return { externalIds: {} } },
    async query(text) {
      const terms = [...new Set(String(text).toLowerCase().match(/[\u4e00-\u9fff]{2}|[a-z0-9_]+/g) ?? [])]
      if (terms.length === 0) return []
      let candidates = null
      for (const term of terms) {
        const hit = new Set(docs.filter((doc) => doc.text.toLowerCase().includes(term)).map((doc) => doc.id))
        candidates = candidates === null ? hit : new Set([...candidates].filter((id) => hit.has(id)))
      }
      return [...(candidates ?? [])]
    },
  }
}

function entryOf(id, seq) {
  return { id, kind: 'projection.span', fidelity: 'synthesized', seq, refs: { spanKind: 'operation' }, inline: {} }
}

test('整条人类消息当查询：AND 无命中时降级为部分匹配，而不是静默返回空', async () => {
  const dir = await newDir()
  try {
    // 库里三条历史；当前查询是一条「尚未归档」的长消息，与历史部分重合。
    const docs = [
      { id: 'r1', text: '排查 ACL 权限问题时发现工作区所有者是 BUILTIN\\Administrators' },
      { id: 'r2', text: 'python 子进程启动失败，冷库后端连不上' },
      { id: 'r3', text: '完全无关的另一段记录内容' },
    ]
    const store = makeStore([entryOf('r1', 1), entryOf('r2', 2), entryOf('r3', 3)], dir)
    const backend = makeAndBackend(docs)

    const longQuery = '我这边 ACL 权限的问题又出现了，工作区所有者还是 BUILTIN\\Administrators，'
      + '你能再确认一下 prepare-workspace 的判定逻辑吗，顺便看看 python 冷库后端那边是不是也有影响'

    // 前置断言：精确 AND 对整条消息确实不可满足（复现 bug 本身）。
    const exact = await backend.query(longQuery, { limit: 20 })
    assert.equal(exact.length, 0, 'AND 对整条长消息应为空 —— 这是 bug 的成因')

    // 期望行为：降级后能找回相关记录。
    const found = await searchRecords({
      store,
      backend,
      text: longQuery,
      limit: 5,
      literalMatcher: () => false,
    })

    assert.ok(found.records.length > 0, '降级检索应命中相关记录，而不是 0 命中')
    assert.ok(
      found.records.some((record) => record.id === 'r1'),
      '应命中与查询重合度最高的 r1（ACL / 所有者）',
    )
    // 必须如实标注这次降级，不得把部分匹配冒充成精确命中。
    assert.equal(found.degraded, true, '部分匹配必须被如实标记为降级')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('短关键词精确命中时不触发降级（契约不变）', async () => {
  const dir = await newDir()
  try {
    const docs = [
      { id: 'r1', text: '厨房做饭洗碗' },
      { id: 'r2', text: '厨房打扫' },
    ]
    const store = makeStore([entryOf('r1', 1), entryOf('r2', 2)], dir)
    const backend = makeAndBackend(docs)

    const found = await searchRecords({
      store,
      backend,
      text: '厨房 做饭',
      limit: 5,
      literalMatcher: () => false,
    })
    assert.deepEqual(found.records.map((record) => record.id), ['r1'])
    assert.equal(found.degraded, false, '精确命中不得被标成降级')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('降级命中仍必须走 D4 过滤：插件来源记录不得进入命中面', async () => {
  const dir = await newDir()
  try {
    const docs = [
      { id: 'plugin1', text: 'ACL 权限工作区所有者问题（插件自己写的卡片）' },
      { id: 'r1', text: 'ACL 权限工作区所有者问题（真实历史）' },
    ]
    const store = makeStore([
      { ...entryOf('plugin1', 1), inline: { pluginAuthored: true } },
      entryOf('r1', 2),
    ], dir)
    const backend = makeAndBackend(docs)

    const found = await searchRecords({
      store,
      backend,
      text: 'ACL 权限的问题又出现了，工作区所有者到底是谁',
      limit: 5,
      literalMatcher: () => false,
    })
    assert.ok(!found.records.some((record) => record.id === 'plugin1'),
      '插件来源记录必须被排除在命中面之外，降级路径也不例外')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('降级不得对空库或完全无关的查询硬凑命中', async () => {
  const dir = await newDir()
  try {
    const store = makeStore([entryOf('r1', 1)], dir)
    const backend = makeAndBackend([{ id: 'r1', text: '厨房做饭' }])

    const found = await searchRecords({
      store,
      backend,
      text: '量子纠缠退相干与贝尔不等式',
      limit: 5,
      literalMatcher: () => false,
    })
    assert.equal(found.records.length, 0, '完全无关时如实返回 0 命中，不得硬凑')
    assert.equal(found.degraded, false, '没命中就不该标成「降级命中」')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
