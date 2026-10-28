/**
 * T2 隔离根节点口径（contracts，单一真源，0.14.0-beta.38）。
 *
 * 为什么单独成文件：镜像节点 ID、冒烟节点 ID、拒绝节点前缀此前分散在
 * probe / provider / 诊断三处各写一遍。诊断侧要「排除冒烟节点、只数真实镜像」，
 * 一旦判据与写入侧漂移，覆盖率就会把冒烟节点算成真实覆盖（用户看到的 233 个 md
 * 里有 1 个是冒烟残留）。三处共用这一份，守卫测试直接对 provider 写入形状断言。
 */

/** 冒烟节点 ID：probeT2Isolated 写入/读回/清理的固定节点，永远不计入真实覆盖。 */
export const T2_SMOKE_NODE_ID = 'mcl-smoke'

/** 真实镜像节点 ID：与本地 v3 记录 ID 同形，可按 ID 精确回读。 */
export const T2_MIRROR_NODE_RE = /^v3r-[0-9a-f]{16}$/

/** 被 dsh-memory 写入闸拒绝的节点（rej_ 前缀）：不是镜像，不得计入覆盖率。 */
export const T2_REJECTED_NODE_RE = /^rej_/
