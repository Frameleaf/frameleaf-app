import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetWhilePaused } from './harness-reset.ts';

test('reset cannot mutate or resume until the last execution has settled', async () => {
  const order = [];
  let release;
  const stopped = new Promise((resolve) => { release = resolve; });
  const initial = [{ name: 'metadata', paused: true }, { name: 'background', paused: false }];
  const work = resetWhilePaused({
    pause: async () => { order.push('paused'); return initial; },
    drain: async () => { order.push('cancel-requested'); await stopped; order.push('stopped'); },
    mutate: async () => { order.push('mutated'); },
    restore: async (snapshot) => { assert.equal(snapshot, initial); order.push('restored'); },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['paused', 'cancel-requested']);
  release();
  await work;
  assert.deepEqual(order, ['paused', 'cancel-requested', 'stopped', 'mutated', 'restored']);
});

test('failed drain forbids mutation and both primary and restoration errors are retained', async () => {
  const primary = new Error('worker stop not confirmed');
  const cleanup = new Error('original pause restoration failed');
  let mutated = false;
  await assert.rejects(resetWhilePaused({
    pause: async () => [],
    drain: async () => { throw primary; },
    mutate: async () => { mutated = true; },
    restore: async () => { throw cleanup; },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, cleanup);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
  assert.equal(mutated, false);
});

test('a data mutation failure still restores the precise original queue states', async () => {
  const error = new Error('database rollback');
  const initial = [{ name: 'metadata', paused: true }, { name: 'background', paused: false }];
  let restored;
  await assert.rejects(resetWhilePaused({
    pause: async () => initial,
    drain: async () => {},
    mutate: async () => { throw error; },
    restore: async (snapshot) => { restored = snapshot; },
  }), (caught) => caught === error);
  assert.equal(restored, initial);
});
