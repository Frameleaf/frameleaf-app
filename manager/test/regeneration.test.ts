import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regenerationPresentation } from '../ui/src/regeneration.js';

test('regeneration reports durable pending, blocked and error states without claiming completion', () => {
  const counts = { completed: 4, total: 10, failed: 2, blocked: 1, needsAttention: 3 };
  for (const state of ['pending_first_setup', 'running', 'waiting', 'unavailable', 'blocked', 'needs_attention']) {
    const display = regenerationPresentation({ state, ...counts });
    assert.doesNotMatch(display.label, /complete|finished/i);
    assert.match(display.detail, /4 of 10 items complete.*2 failed.*1 blocked/);
    assert.match(display.detail, /3 need attention/);
  }
  assert.equal(regenerationPresentation({ state: 'completed_with_errors', ...counts }).label, 'Regeneration finished with errors');
  assert.equal(regenerationPresentation({ state: 'completed_with_errors', ...counts }).attention, true);
  assert.equal(regenerationPresentation({ state: 'completed', ...counts }).label, 'Regeneration complete');
  assert.equal(regenerationPresentation({ state: 'unknown', ...counts }).label, 'Waiting for regeneration status');
});
