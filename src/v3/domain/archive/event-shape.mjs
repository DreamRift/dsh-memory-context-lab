/**
 * DSH 事件形状的唯一读取点（0.14.0-beta.44）。
 *
 * 为什么单独成模块：归档选择器（回合级 candidates / 步骤级 steps）都要回答
 * 「这条事件是谁写的」「这个工具调用/结果属于哪个 callId」。0.14.0-beta.43 之前
 * 两处各抄一份 `callIdOf`，结果都只认旧夹具的 `data.callId`，漏掉真实宿主的
 * `data.message.toolCallId` / `data.message.source.callId`：
 * 每个 tool/result 都被判「不存在」→ 每个 tool/call 都永远「未完成」→
 * 按轮与按步归档同时失效（真实会话 76/76 步骤 unfinished）。
 *
 * 纪律：**新增事件形状只改这里**，不要在 candidates/steps 里再写一份。
 * 真实宿主（DSH Desktop 0.2.1-rc.3）形状：
 * - user/message：`data.source.kind === 'user'`；
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
 * 回注包（form 'recall'）：不是回执，不遮蔽历史、不写 v3 记录。
 * 按透明节点处理：不阻断、不要求记录；被遮蔽时随 span 消失，恢复时不偿还。
 */
export function isRecallPackEvent(event) {
  return sourceKindOf(event) === 'dsh-memory-context-lab' && sourceFormOf(event) === 'recall';
}
