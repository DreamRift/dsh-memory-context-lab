/**
 * mcl.status/v1 — the canonical closed vocabulary for MCL execution status.
 * This module defines membership only; it does not map adapter errors or add defaults.
 */
export const MCL_STATUS_CONTRACT_ID = 'mcl.status/v1';

export const MCL_STATUS_VOCABULARY = Object.freeze([
  'ok',
  'partial',
  'unknown',
  'unavailable',
  'stale',
  'conflict',
  'failed',
  'rejected',
]);

const statusSet = new Set(MCL_STATUS_VOCABULARY);

export function isMclStatus(value) {
  return typeof value === 'string' && statusSet.has(value);
}

export function assertMclStatus(value) {
  if (!isMclStatus(value)) {
    throw new TypeError('Invalid ' + MCL_STATUS_CONTRACT_ID + ' status: expected one of ' + MCL_STATUS_VOCABULARY.join(', ') + '.');
  }
  return value;
}
