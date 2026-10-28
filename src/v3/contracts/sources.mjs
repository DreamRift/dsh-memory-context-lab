/**
 * 消息来源标识（contracts，单一真源）。
 *
 * 为什么单独成文件：这三个字面量此前分散在三处各写一遍——
 * - `entry/v3-entry.mjs` 的 OWN_SOURCE_KIND（摄入跳过自家生成物）；
 * - `adapters/host/dsh-host.mjs` 的 V3_PLUGIN_SOURCE_KIND（表面写入用）；
 * - `src/index.mjs` 的回注消息 `source.kind = name`（= 'memory-context-lab'）。
 *
 * 第三处与包名不同，后果不是「不好看」：回注包以 'memory-context-lab' 入库，
 * 摄入侧的 `kind === OWN_SOURCE_KIND` 判据（'dsh-memory-context-lab'）永远不命中，
 * 于是插件把自己注入的检索包当成用户历史反复摄入——历史事故「工作状态卡 31× 重复
 * 污染」的同形态复发。判据必须只有一份，且必须等于宿主看到的包名。
 *
 * 纪律：**不要**为了让某处匹配而改这里的字面值。它参与 `ownSourceKinds` 的历史
 * 回合重算（domain/session/turn.mjs），改值会改变旧会话里「什么算真实用户回合」。
 */

/** 本插件写入宿主消息时的 source.kind：必须等于 package.json 的 name（守卫钉住）。 */
export const PLUGIN_SOURCE_KIND = 'dsh-memory-context-lab'

/** 宿主对「人类输入」的 source.kind 约定（dsh-api-session-controller 写入 user/message 时使用）。 */
export const HUMAN_SOURCE_KIND = 'user'

/** 插件写入的 source.form：回注包。 */
export const RECALL_SOURCE_FORM = 'recall'
