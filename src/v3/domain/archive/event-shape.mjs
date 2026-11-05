/**
 * DSH 事件形状的唯一读取点（0.14.0-beta.44 起；0.15.0 R06 增调用声明解析）。
 *
 * 为什么单独成模块：归档选择器（回合级 candidates / 步骤级 steps）都要回答
 * 「这条事件是谁写的」「这个工具调用/结果属于哪个 callId」。0.14.0-beta.43 之前
 * 两处各抄一份 `callIdOf`，结果都只认旧夹具的 `data.callId`，漏掉真实宿主的
 * `data.message.toolCallId` / `data.message.source.callId`：
 * 每个 tool/result 都被判「不存在」→ 每个 tool/call 都永远「未完成」→
 * 按轮与按步归档同时失效（真实会话 76/76 步骤 unfinished）。
 *
 * 纪律：**新增事件形状只改这里**，不要在 candidates/steps 里再写一份。
 * 真实宿主（DSH Desktop 0.2.1-rc.x）形状：
 * - user/message：`data.source.kind === 'user'`；
 * - assistant/message：调用声明在 `data.message.content[]` 的 `tool-call` 块
 *   （`{type,id,name,arguments}`），**tool/call 事件本体是 log-only（不在活动面）**；
 * - tool/call：`data.callId`；
 * - tool/result：`data.message.toolCallId`，且 `data.message.source.callId` 同值；
 * - 旧夹具/旧版本：`data.callId` 或 `data.message.content[].callId`。
 */

export function sourceKindOf(event) {
  return event?.data?.source?.kind ?? event?.source?.kind ?? null;
}

export function sourceFormOf(event) {
  return event?.data?.source?.form ?? event?.source?.form ?? null;
}

/**
 * 工具调用/结果的配对键。
 * 顺序按「真实宿主优先、旧夹具兜底」，任何一条取不到就继续找下一条；
 * 全部取不到返回 null（调用方据此判「没有可配对的 callId」，不猜）。
 */
export function callIdOf(event) {
  if (typeof event?.data?.callId === 'string') return event.data.callId;
  if (typeof event?.data?.toolCallId === 'string') return event.data.toolCallId;
  if (typeof event?.data?.message?.toolCallId === 'string') return event.data.message.toolCallId;
  if (typeof event?.data?.message?.source?.callId === 'string') return event.data.message.source.callId;
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part?.callId === 'string') return part.callId;
  }
  return null;
}

/** 真人 user/message（宿主约定 source.kind === 'user'）。 */
export function isHumanUserEvent(event) {
  return event?.type === 'user/message' && sourceKindOf(event) === 'user';
}

/** 插件自己的 surface 节点（回执/恢复）：不参与归档，且作为 span 的硬边界。 */
export function isPluginSurfaceEvent(event) {
  return sourceKindOf(event) === 'dsh-memory-context-lab';
}

/**
 * 结构性活动面节点（system/message、developer/message）：插件**不摄入**（摄入封闭集只含
 * user/assistant/tool），因此永远没有 v3 记录；宿主还规定 node 0（系统提示）只能由
 * system/message 原节点改写，user 回执不得覆盖它。归档选择器把这类节点当**边界**：
 * 不纳入任何轮组（留在活动面上），也不让它们把后续轮堵死（AUD48-04-04）。
 *
 * 只在这里定义一次——candidates（回合级）与后续按步选择器都从这里取判据。
 */
export function isStructuralSurfaceEvent(event) {
  return event?.type === 'system/message' || event?.type === 'developer/message';
}

/**
 * assistant 消息**声明**的工具调用（0.15.0 R06）。
 *
 * 返回 `{ ids, malformed, ambiguous }`：
 * - `ids`：可证明身份的全部候选 id。真实宿主块是 `{type,id,...}`，旧夹具是
 *   `{type,callId,...}`；两者都非空且不同时**都收**（`ambiguous=true`），
 *   不静默偏爱其中一个——身份未证明时由调用方保守处理（两个候选都要有结果才算闭合）。
 * - `malformed`：存在既无 id 也无 callId 的调用块。这类消息**不能当成「没有调用」**：
 *   未知不等于空集，调用方必须保守保护（遮蔽后无法证明调用与结果的配对关系）。
 * - 非 assistant/message 或没有 tool-call 块：`{ ids: [], malformed: false, ambiguous: false }`。
 *
 * 同一 id 重复声明只保留一次（重复块不放大恢复要求）。
 */
export function toolCallDeclarationsOf(event) {
  const empty = { ids: [], malformed: false, ambiguous: false };
  if (event?.type !== 'assistant/message') return empty;
  const content = event?.data?.message?.content ?? event?.data?.content;
  if (!Array.isArray(content)) return empty;
  const ids = [];
  const seen = new Set();
  let malformed = false;
  let ambiguous = false;
  for (const block of content) {
    if (block?.type !== 'tool-call') continue;
    const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : '';
    const callId = typeof block.callId === 'string' && block.callId.length > 0 ? block.callId : '';
    if (id.length === 0 && callId.length === 0) { malformed = true; continue; }
    if (id.length > 0 && callId.length > 0 && id !== callId) ambiguous = true;
    for (const candidate of [id, callId]) {
      if (candidate.length === 0 || seen.has(candidate)) continue;
      seen.add(candidate);
      ids.push(candidate);
    }
  }
  return { ids, malformed, ambiguous };
}

/**
 * 调用闭包的**唯一判据**（0.15.0 R06；回合级 candidates 与步骤级 steps 共用）。
 *
 * 输入是一次操作单元（一个回合组 / 一个步骤 / 一段连续候选范围）内的两侧集合：
 * - `invocationIds`：声明（assistant 结构块）∪ 已见 tool/call 的 id；
 * - `resultIds`：同一范围内已见的 tool/result id；
 * - `malformed`：范围内存在无法识别身份的调用块。
 *
 * 只有两侧**完全相等**才算闭合：
 * - 声明/调用没有结果 → `missingIds`（操作没做完，遮蔽会拆掉结果那一侧）；
 * - 结果没有对应的声明/调用 → `orphanIds`（声明在范围外或根本缺失，单边遮蔽）；
 * - 身份不可识别 → `malformed`。
 *
 * 三种情况都必须保守保护：候选范围必须**整体**覆盖一次操作的两端，不能只搬一侧。
 */
export function toolClosureOf({ invocationIds = [], resultIds = [], malformed = false } = {}) {
  const invocation = new Set(invocationIds);
  const result = new Set(resultIds);
  const missingIds = [];
  for (const id of invocation) if (!result.has(id)) missingIds.push(id);
  const orphanIds = [];
  for (const id of result) if (!invocation.has(id)) orphanIds.push(id);
  return {
    closed: malformed !== true && missingIds.length === 0 && orphanIds.length === 0,
    missingIds,
    orphanIds,
    malformed: malformed === true,
  };
}

/**
 * 调用事件索引（0.15.0 R06）：callId → 声明/调用所在 seq（inv）与结果所在 seq（res）。
 *
 * 用途：闭包不仅要在**候选范围内**两侧相等，还要证明这次操作**没有被拆到范围外**
 * （声明/调用留在面上、或结果留在面上）。索引按 append-only 日志增量维护：
 * candidates 复用 bySeq 同一趟遍历，steps 每次选择重建一次（它本来就要整表切步骤）。
 */
export function createToolCallIndex() {
  return { byId: new Map(), malformedSeqs: new Set() }
}

function bucketOf(index, id) {
  let bucket = index.byId.get(id)
  if (bucket === undefined) {
    bucket = { inv: new Set(), res: new Set() }
    index.byId.set(id, bucket)
  }
  return bucket
}

/** 把一条事件并入索引（幂等：Set 去重；同一事件重复合并无副作用）。 */
export function indexToolCallEvent(index, event) {
  if (index === null || typeof index !== 'object') return index
  if (!Number.isInteger(event?.seq)) return index
  const declaration = toolCallDeclarationsOf(event)
  if (declaration.malformed) index.malformedSeqs.add(event.seq)
  for (const id of declaration.ids) bucketOf(index, id).inv.add(event.seq)
  const callId = callIdOf(event)
  if (event.type === 'tool/call' && callId !== null) bucketOf(index, callId).inv.add(event.seq)
  if (event.type === 'tool/result' && callId !== null) bucketOf(index, callId).res.add(event.seq)
  return index
}

/**
 * 候选范围的闭包判据（R06 的完整形态）：**范围内两侧相等** + **没有单边留在范围外**。
 *
 * 只做范围内容器相等还不够：一次调用的声明可能落在范围外、结果落在范围内（或反之），
 * 遮蔽结果那一侧就把操作拆成了两半。索引在这里只用于「同一 id 的出现位置」，
 * 不把全会话的结果搬进每一步。
 *
 * 同名 id 的两侧都在范围外 = 另一个完整操作（重复 id），不算拆分——否则同一 callId
 * 被重用时会让后面的回合永久不可归档。
 */
export function toolClosureOfRange({ invocationIds = [], resultIds = [], malformed = false, index = null, startSeq, endSeq } = {}) {
  const inside = toolClosureOf({ invocationIds, resultIds, malformed })
  if (inside.closed !== true) return inside
  if (index === null || !Number.isInteger(startSeq) || !Number.isInteger(endSeq)) return inside
  const outside = (seq) => seq < startSeq || seq > endSeq
  const splitIds = []
  for (const id of new Set([...invocationIds, ...resultIds])) {
    const bucket = index.byId.get(id)
    if (bucket === undefined) continue
    let invOut = false
    for (const seq of bucket.inv) if (outside(seq)) { invOut = true; break }
    let resOut = false
    for (const seq of bucket.res) if (outside(seq)) { resOut = true; break }
    if (invOut !== resOut) splitIds.push(id)
  }
  if (splitIds.length === 0) return inside
  return { ...inside, closed: false, splitIds }
}

/**
 * 回注包（form 'recall'）：不是回执，不遮蔽历史、不写 v3 记录。
 * 按透明节点处理：不阻断、不要求记录；被遮蔽时随 span 消失，恢复时不偿还。
 */
export function isRecallPackEvent(event) {
  return sourceKindOf(event) === 'dsh-memory-context-lab' && sourceFormOf(event) === 'recall';
}
