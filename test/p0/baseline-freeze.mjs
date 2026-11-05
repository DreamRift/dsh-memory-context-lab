/**
 * P0 现行基线冻结值（0.15.0）——**唯一出处**，只描述「已提交快照」，不描述工作区。
 *
 * 为什么单列一个模块：指纹脚本、P0 门禁、文档三处必须引用同一份常量；
 * 任何一处手抄一个哈希，都会在「换基线」时悄悄分叉。
 *
 * 边界（不得升级）：
 * - 这里只冻结**代码/测试快照**与**已实测的全量数字**；不代表真实宿主集成、
 *   不代表供应商 wire 观测、更不代表可发布。
 * - 数值只能从同一已提交快照采集（规范 §10）。工作区脏文件一律不参与。
 *
 * 历史快照：`67e708c6f5b884a0df7ca567acb4765794a42dd1` 是 P0 起始基线（beta.55 候选未升号），
 * 其指纹与红色夹具结果仍保留在 `docs/dev-0.15.0/P0-基线证据.md` §1/§4 作历史证据；
 * 现行口径以本文件为准。
 */

export const BASELINE = Object.freeze({
  commit: 'ca1083a60f87765622ba0bf8089d70e1103cb8ba',
  tree: '97d12b9a27dacac22837a780483254194d7c8d17',
  manifest: Object.freeze({ name: 'dsh-memory-context-lab', version: '0.14.0-beta.54' }),
  // 算法：sha256(sorted(relPath + NUL + LF-normalized blob + NUL))[:16]，按指定提交的 git blob 计算。
  fingerprints: Object.freeze({
    src: '55e7bcfff4764979',
    test: 'eefeceb50da19c40',
    scripts: '28a88ba2d7f2f7c9',
    'package.json': '071f0ad812b391a5',
  }),
  testRun: Object.freeze({
    date: '2026-11-01',
    node: 'v26.12.1',
    platform: 'win32',
    arch: 'x64',
    suites: 144,
    tests: 725,
    pass: 719,
    fail: 0,
    skip: 6,
    exitCode: 0,
    command: 'cd 记忆上下文/plugin; node scripts/test-all.mjs',
  }),
  // 该提交 test/*.test.mjs 顶层套件数（P0 子目录按设计不进入全量 CI）。
  topLevelTestFiles: 144,
  host: Object.freeze({
    packageName: '@deepseek-ai/dsh-desktop-runtime',
    version: '0.2.1-rc.5',
    contractChecks: 28,
  }),
})

/** 证据分级与非主张：任何输出都要带上，避免把源码/夹具当成真实运行证据。 */
export const EVIDENCE_SCOPE = Object.freeze(['source-level', 'fixture-level'])

export const NON_CLAIMS = Object.freeze([
  '未在真实运行宿主上观测 pre-step → buildRequest 的运行时序',
  '未观测供应商 wire JSON（llm/stream 只是 adapter 之前的逻辑请求）',
  '未验证 outbound-request 观测范围，只有 plugin-surface',
  '未构建脱敏可回放的请求/活动面轨迹',
  '未做真实模型/供应商缓存字段实测与收益测量',
])
