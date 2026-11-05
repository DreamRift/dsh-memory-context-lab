import { RECEIPT_MAX_CHARS, RECEIPT_MIN_SUMMARY_CHARS, RECEIPT_SUMMARY_SAFETY_MARGIN } from '../../archive/receipt.mjs'
import { SUMMARY_SCHEMA_VERSION } from '../../../contracts/summaries.mjs'
import { SUMMARY_GENERATOR_VERSIONS, MODEL_GENERATOR_VERSION } from '../summary.mjs'
import { fnv1a64Of } from '../../../shared/fnv1a64.mjs'

export const GENERATION_CONTRACT_VERSION = 1
export const GENERATION_REASON = Object.freeze(['parent-range-complete', 'batch-threshold', 'backlog-coalesce', 'manual-explicit', 'shadow-compare'])
export const GENERATION_VERSION_FIELDS = Object.freeze(['contractVersion', 'summaryVersion', 'receiptBudgetIdentity'])
export const SUMMARY_GENERATORS = Object.freeze([...SUMMARY_GENERATOR_VERSIONS, MODEL_GENERATOR_VERSION])
const FROZEN_RECEIPT_BUDGET_IDENTITY = 'rb-400-40-12'
const receiptBudgetIdentityOf = () => {
  const values = [RECEIPT_MAX_CHARS, RECEIPT_MIN_SUMMARY_CHARS, RECEIPT_SUMMARY_SAFETY_MARGIN]
  return values.every(Number.isSafeInteger) ? 'rb-' + values.join('-') : null
}

export function generationVersionTuple(generator = SUMMARY_GENERATORS[0]) {
  if (!SUMMARY_GENERATORS.includes(generator)) throw new TypeError('unsupported-summary-generator')
  const summaryVersion = Object.freeze({ schema: SUMMARY_SCHEMA_VERSION, generator })
  return Object.freeze({
    contractVersion: GENERATION_CONTRACT_VERSION,
    summaryVersion: Object.freeze(summaryVersion),
    receiptBudgetIdentity: receiptBudgetIdentityOf(),
  })
}

const seqsMatchRange = (range) => {
  if (range === null) return true
  if (!range || !Number.isInteger(range.startSeq) || !Number.isInteger(range.endSeq) || range.startSeq < 0 || range.endSeq < range.startSeq || !Array.isArray(range.sourceEventSeqs)) return false
  const seqs = range.sourceEventSeqs
  return seqs.length > 0 && seqs[0] === range.startSeq && seqs[seqs.length - 1] === range.endSeq && seqs.every((n, i) => Number.isInteger(n) && n >= 0 && (!i || n > seqs[i - 1]))
}

export function makeGenerationRecord({ candidateRange, parentRange = null, sourceRecordIds, sourceRecordSeqs, transientSeqs, reason, restoreEntry, versions = generationVersionTuple() } = {}) {
  const sourceSeqsMatch = Array.isArray(sourceRecordSeqs) && Array.isArray(transientSeqs) && Array.isArray(candidateRange?.sourceEventSeqs) && sourceRecordSeqs.length === sourceRecordIds?.length && [...sourceRecordSeqs, ...transientSeqs].sort((a, b) => a - b).every((seq, index) => seq === candidateRange.sourceEventSeqs[index]) && sourceRecordSeqs.length + transientSeqs.length === candidateRange.sourceEventSeqs.length && sourceRecordSeqs.every((seq, index) => Number.isInteger(seq) && (!index || seq > sourceRecordSeqs[index - 1])) && transientSeqs.every((seq, index) => Number.isInteger(seq) && (!index || seq > transientSeqs[index - 1]))
  const expectedReceiptBudgetIdentity = receiptBudgetIdentityOf()
  const validTuple = versions && Object.keys(versions).length === GENERATION_VERSION_FIELDS.length && GENERATION_VERSION_FIELDS.every((key) => Object.hasOwn(versions, key) && versions[key] != null) && versions.contractVersion === GENERATION_CONTRACT_VERSION && versions.summaryVersion && Object.keys(versions.summaryVersion).length === 2 && Object.hasOwn(versions.summaryVersion, 'schema') && Object.hasOwn(versions.summaryVersion, 'generator') && versions.summaryVersion.schema === SUMMARY_SCHEMA_VERSION && SUMMARY_GENERATORS.includes(versions.summaryVersion.generator) && expectedReceiptBudgetIdentity === FROZEN_RECEIPT_BUDGET_IDENTITY && versions.receiptBudgetIdentity === expectedReceiptBudgetIdentity
  if (!candidateRange || !seqsMatchRange(candidateRange) || !Array.isArray(sourceRecordIds) || sourceRecordIds.length === 0 || sourceRecordIds.some((id) => typeof id !== 'string' || !id.length) || !sourceSeqsMatch || sourceRecordIds.length > candidateRange.sourceEventSeqs.length || !GENERATION_REASON.includes(reason) || !seqsMatchRange(parentRange) || !validTuple || !restoreEntry || !['voucher', 'record-read'].includes(restoreEntry.kind) || !Array.isArray(restoreEntry.recordIds) || restoreEntry.recordIds.length !== sourceRecordIds.length || restoreEntry.recordIds.some((id, i) => id !== sourceRecordIds[i]) || !Number.isInteger(restoreEntry.expectedReceiptChars) || restoreEntry.expectedReceiptChars < 0 || typeof restoreEntry.kind !== 'string') return { ok: false, status: 'rejected', reason: 'generation-record-incomplete' }
  const freezeRange = (range) => range == null ? null : Object.freeze({ startSeq: range.startSeq, endSeq: range.endSeq, sourceEventSeqs: Object.freeze([...range.sourceEventSeqs]) })
  const tuple = Object.freeze({ contractVersion: versions.contractVersion, summaryVersion: Object.freeze({ schema: versions.summaryVersion.schema, generator: versions.summaryVersion.generator }), receiptBudgetIdentity: versions.receiptBudgetIdentity })
  const candidate = freezeRange(candidateRange)
  const parent = freezeRange(parentRange)
  const record = Object.freeze({ parentRange: parent, sourceRecordIds: Object.freeze([...sourceRecordIds]), generationVersionTuple: tuple, reason, recoveryEntry: Object.freeze({ ...restoreEntry, recordIds: Object.freeze([...restoreEntry.recordIds]) }) })
  const identityMaterial = JSON.stringify({ candidateRange: candidate, sourceRecordIds: record.sourceRecordIds, generationVersionTuple: tuple, reason, parentRange: parent })
  return { ok: true, record, candidateRange: candidate, compressionGenerationId: 'i2g-' + fnv1a64Of(identityMaterial) }
}
