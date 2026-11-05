import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCL_STATUS_CONTRACT_ID,
  MCL_STATUS_VOCABULARY,
  assertMclStatus,
  isMclStatus,
} from '../src/v3/contracts/status-vocabulary.mjs';

test('mcl.status/v1 exposes exactly the canonical eight statuses', () => {
  assert.equal(MCL_STATUS_CONTRACT_ID, 'mcl.status/v1');
  assert.deepEqual(MCL_STATUS_VOCABULARY, [
    'ok', 'partial', 'unknown', 'unavailable', 'stale', 'conflict', 'failed', 'rejected',
  ]);
  assert.equal(new Set(MCL_STATUS_VOCABULARY).size, 8);
});

test('the vocabulary is frozen and cannot be extended or edited', () => {
  assert.equal(Object.isFrozen(MCL_STATUS_VOCABULARY), true);
  assert.throws(() => MCL_STATUS_VOCABULARY.push('success'), TypeError);
  assert.throws(() => { MCL_STATUS_VOCABULARY[0] = 'success'; }, TypeError);
  assert.equal(MCL_STATUS_VOCABULARY[0], 'ok');
});

test('membership and assertion accept each canonical status unchanged', () => {
  for (const status of MCL_STATUS_VOCABULARY) {
    assert.equal(isMclStatus(status), true);
    assert.equal(assertMclStatus(status), status);
  }
});

test('unknown and near-match values are rejected without coercion', () => {
  for (const value of ['success', 'okay', 'partially', 'unknown ', 'OK', 'Ok', '', null, undefined, 0, false]) {
    assert.equal(isMclStatus(value), false, String(value));
    assert.throws(() => assertMclStatus(value), TypeError);
  }
});
