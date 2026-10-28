/**
 * contracts 聚合出口：application/领域消费方统一从这里取合同，
 * 单一真源仍在各模块（此处只转发，不新增定义）。
 */
export { ERROR_CODES, ERROR_KINDS, V3ContractViolation, v3Error, isV3Error } from './errors.mjs'
export { EVENT_TYPES, EVENT_FIELDS, validateEvent } from './events.mjs'
export { DECISION_KINDS, DECISION_FIELDS, EFFECT_KINDS, sealDecision, validateDecision } from './decisions.mjs'
export { RECORD_KINDS, RECORD_FIELDS, assertValidRecord, validateRecord } from './records.mjs'
export { OUTCOME_STATUSES, OUTCOME_FIELDS, validateOutcome } from './outcomes.mjs'
export { REQUIRED_T2_TOOLS, TESTED_DSH_MEMORY_VERSIONS, negotiateMemoryProvider } from './capabilities.mjs'
export { PLUGIN_SOURCE_KIND, HUMAN_SOURCE_KIND, RECALL_SOURCE_FORM } from './sources.mjs'
export { T2_SMOKE_NODE_ID, T2_MIRROR_NODE_RE, T2_REJECTED_NODE_RE } from './t2.mjs'
