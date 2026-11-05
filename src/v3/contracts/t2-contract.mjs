/**
 * 灵枢 T2 版本合同表（contracts，0.15.0 P5）。
 *
 * 单一真源：**哪些版本可升 T2、read 检索用哪个参数、资格字段叫什么、
 * 查询合同是否经过隔离 MCP 冒烟**，全部在这里登记；能力协商、provider 参数
 * 与诊断都从这里读，不在各层各写一份版本判断。
 *
 * 证据边界（不夸大）：
 * - 0.9.10：2026-10-28 隔离 MCP 冒烟通过 initialize / tools/list / cg write /
 *   read-by-id / forget；**搜索参数与资格字段未在 0.9.10 上做过隔离查询冒烟**，
 *   故 readQueryVerified=false（能力状态报 contract，不冒充已验证）。
 * - 0.9.17：2026-11-01 对本机 lingshu-src（commit 6759c118…，干净检出）执行
 *   隔离 MCP 冒烟，并补做 cg read(query, k) 合同探针：返回 results 行含
 *   node/score/state/reason，k 上限 500（越界返回 warning.code=k_out_of_range）。
 *   **状态是 candidate，不是默认启用**：证据足够描述合同，但版本列表默认切换
 *   会把所有装着 0.9.17 的环境从未经验证的 T1 切到新的 T2 写入路径，属于产品
 *   决策，不由本切片替你拍板。启用需显式把 status 提升为 tested（或在后续发布
 *   决策中单独授权）。
 *
 * 未登记/候选版本一律 fail-closed 回 T1（见 capabilities.negotiateMemoryProvider）。
 */

/** 隔离路线工具面（与 capabilities 的必需工具同源语义，避免两处漂移）。 */
export const T2_CONTRACT_ID = 'cg-read-v1'

/** 版本合同条目：只登记已通过隔离 MCP 冒烟的版本。 */
export const T2_VERSION_CONTRACTS = Object.freeze({
  '0.9.10': Object.freeze({
    status: 'tested',
    readSearchParam: 'k',
    readSearchLimitMax: null,
    readQueryVerified: false,
    eligibilityField: 'state',
    eligibilityStates: Object.freeze(['ACCEPT', 'DEFER', 'BLINDSPOT', 'REJECT']),
    evidence: '2026-10-28 隔离 MCP 冒烟（initialize/tools/list/cg write/read-by-id/forget）；read-query 参数与资格字段未实测',
  }),
  '0.9.17': Object.freeze({
    status: 'candidate',
    readSearchParam: 'k',
    readSearchLimitMax: 500,
    readQueryVerified: true,
    eligibilityField: 'state',
    eligibilityStates: Object.freeze(['ACCEPT', 'DEFER', 'BLINDSPOT', 'REJECT']),
    evidence: '2026-11-01 隔离 MCP 冒烟 + cg read(query,k) 合同探针：results 行含 node/score/state/reason，k>500 返回 k_out_of_range warning',
  }),
})

/** 取版本合同；未登记返回 null（调用方 fail-closed）。 */
export function t2ContractOf(version) {
  if (typeof version !== 'string' || version.length === 0) return null
  return Object.hasOwn(T2_VERSION_CONTRACTS, version) ? T2_VERSION_CONTRACTS[version] : null
}

function feature(state, reason) {
  return { state, reason }
}

/**
 * 分能力协商结果（开发流程 §4.2）：版本、schema 摘要、探针结果与逐项降级理由。
 *
 * @param {object} described 探测结果（t2-probe 产出）
 * @returns {object} 能力报告；**不抛错**（形状错误由上层协商负责）
 */
export function t2CapabilitiesOf(described) {
  const version = typeof described?.version === 'string' ? described.version : ''
  const contract = t2ContractOf(version)
  const tools = Array.isArray(described?.tools) ? described.tools : []
  const smokePassed = described?.smokePassed === true
  const queryProbe = described?.queryContract
  // 候选版本也出具能力报告（诊断/预演用），但**协商是否升 T2** 由 capabilities 的
  // TESTED/CANDIDATE 名单裁决；这里只描述「这份版本合同能做到什么」。
  const basicMirror = contract !== null
    && (contract.status === 'tested' || contract.status === 'candidate')
    && smokePassed
    && tools.includes('cg')
  const queryState = !basicMirror
    ? 'off'
    : queryProbe?.passed === false
      ? 'off'
      : contract.readQueryVerified === true || queryProbe?.passed === true
        ? 'on'
        : 'contract'
  const queryReason = !basicMirror
    ? '基础能力未通过（版本/冒烟/工具面），检索一并关闭'
    : queryProbe?.passed === false
      ? 'cg read(query) 合同探针未通过：' + String(queryProbe.reason ?? '未知原因')
      : queryState === 'on'
        ? 'cg read(query,' + contract.readSearchParam + ') 合同已验证；k 上限 ' + String(contract.readSearchLimitMax ?? '未测')
        : 'cg read(query) 合同仅登记未隔离冒烟；按候选面使用，不参与自动装包'
  const features = {
    basicMirror: feature(
      basicMirror ? 'on' : 'off',
      basicMirror
        ? '隔离 MDCG_ROOT + cg 工具面 + 冒烟通过（' + version + '）'
        : '版本未实测/冒烟未过/缺 cg：' + String(described?.error ?? '未提供原因').slice(0, 200),
    ),
    searchQuery: feature(queryState, queryReason),
    queryExcerpt: feature(
      'off',
      'T2 只提供候选/排名：镜像正文是六要素包装，灵枢 spans 指向包装正文而非本地 payload.text；未验证映射前窗口从本地原记录重选',
    ),
    multiPathRecall: feature('off', '本版只接 cg read 的 BM25 路径，多路召回未启用'),
    taskFactMirror: feature('off', 'task_memory 镜像未实现（本版不建双任务真源）'),
  }
  const packExternal = feature(
    'off',
    'T2 RRF 分数与本地 BM25 不同尺，资格四态也未校准；自动装包只收本地结果（R03：弱候选不因名次穿 pack 门）',
  )
  return {
    providerVersion: version,
    contractId: T2_CONTRACT_ID,
    schemaDigest: typeof described?.schemaDigest === 'string' ? described.schemaDigest : null,
    probe: {
      smokePassed,
      queryContract: queryProbe ?? { passed: false, state: 'not-run', reason: '未执行查询合同探针' },
    },
    features,
    packExternal,
    downgraded: [
      ...Object.entries(features)
        .filter(([, value]) => value.state !== 'on')
        .map(([name, value]) => ({ feature: name, reason: value.reason })),
      { feature: 'packExternal', reason: packExternal.reason },
    ],
  }
}
