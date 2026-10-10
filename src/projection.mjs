/**
 * The `memoryContextLab` session projection.
 *
 * This is the whole reason the plugin survives resume, fork, and HMR: the
 * settings the composer panel shows, and the count of archived operations, are
 * folded from the session log itself — never from plugin memory. The command
 * executor already records every `/memory-lab ...` line as a log-only
 * `command/run`, so folding those records reconstructs the user's intent, and
 * folding surface replacements reconstructs what is currently archived.
 *
 * `apply` is pure and synchronous and returns the same reference for events it
 * ignores, so unchanged state costs nothing downstream. It never throws: a
 * malformed event must not be able to blank a client slot.
 */

import { foldCommandIntoState, initialProjectionState, isReceiptMessage } from './core.mjs'

/** Surface event types that can carry a `surfaceOp`. */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** The projection registry only requires a `.parse`; values are already plain JSON. */
export const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (value) => value })

/** Build the initial fold state, including the receipt bookkeeping. */
export function initProjectionState() {
  return { ...initialProjectionState(), receiptSeqs: [] }
}

/** The client-visible view. Plain JSON, no functions, no undefined. */
export function viewOf(state) {
  const target = state.targetOccupancy
  const margin = state.releaseMarginRatio
  const retain = state.retainOperations
  const batch = state.archiveBatchSize
  return {
    enabled: state.enabled === true,
    targetOccupancy: typeof target === 'number' && Number.isFinite(target) && target > 0 && target < 1 ? target : null,
    retainOperations: Number.isInteger(retain) && retain >= 0 && retain <= 200 ? retain : 0,
    archiveBatchSize: Number.isInteger(batch) && batch >= 1 && batch <= 200 ? batch : 10,
    releaseMarginRatio: typeof margin === 'number' && Number.isFinite(margin) && margin >= 0 && margin <= 1 ? margin : 0,
    auto: state.auto === true,
    autoRecall: state.autoRecall === true,
    autoRestore: state.autoRestore !== false,
    archived: Array.isArray(state.receiptSeqs) ? state.receiptSeqs.length : 0,
    restored: Number.isInteger(state.restored) && state.restored >= 0 ? state.restored : 0,
    revision: Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
  }
}

/**
 * Fold one committed session event into the projection state.
 *
 * @param state - the previous state.
 * @param event - one committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
export function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state

  if (event.type === 'command/run') {
    if (event.data?.name !== 'memory-lab') return state
    const next = { ...state }
    if (!foldCommandIntoState(next, event.data?.args ?? '')) return state
    next.revision = (state.revision ?? 0) + 1
    return next
  }

  if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) return state

  const shadowed = event.surfaceOp === 'append'
    ? null
    : new Set(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])
  const isReceipt = event.type === 'user/message' && isReceiptMessage(event.data)
  const seqs = Array.isArray(state.receiptSeqs) ? state.receiptSeqs : []
  const replacedReceipt = shadowed !== null && seqs.some((seq) => shadowed.has(seq))

  // A replacement that shadows no receipt and is not itself a receipt is not
  // ours: compaction and the runtime-context snapshot replace spans too.
  if (!replacedReceipt && !isReceipt) return state

  let receiptSeqs = seqs
  let restored = Number.isInteger(state.restored) && state.restored >= 0 ? state.restored : 0
  if (replacedReceipt) {
    receiptSeqs = receiptSeqs.filter((seq) => !shadowed.has(seq))
    // Replacing a receipt with something else is exactly what `restore` does.
    if (!isReceipt) restored += 1
  }
  // Only a replacement makes a receipt an archive action. A receipt that merely
  // appended never shadowed an operation, so counting it would overstate what
  // the plugin has actually cooled.
  if (isReceipt && shadowed !== null) {
    if (receiptSeqs.includes(event.seq)) return state
    receiptSeqs = [...receiptSeqs, event.seq]
  }

  return {
    ...state,
    receiptSeqs,
    archived: receiptSeqs.length,
    restored,
    revision: (state.revision ?? 0) + 1,
  }
}

/** The registry definition, ready for `ctx.sessionProjections.register(...)`. */
export const memoryContextLabProjection = {
  key: 'memoryContextLab',
  stateVersion: 1,
  stateSchema: PASSTHROUGH_SCHEMA,
  init: () => initProjectionState(),
  apply: applyEvent,
  wire: { viewSchema: PASSTHROUGH_SCHEMA, view: viewOf },
}
