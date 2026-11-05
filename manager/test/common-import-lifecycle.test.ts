import assert from 'node:assert/strict';
import test from 'node:test';
import { completeCommonImport, rollbackCommonImport } from '../src/common-import-lifecycle.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const source = { kind: 'photoprism', version: 'fixture' } as const;
const fresh = { run: null, execution: null };
const state = (status: string, phase = status, writersMayHaveStarted = false) => ({
  run: { operationId, source, status },
  execution: { phase, writersMayHaveStarted, abandoned: status === 'abandoned' },
});
const activated = state('activated', 'activated', true);

test('selects fresh, resumed and interrupted activation paths from durable state', async () => {
  for (const [initial, afterTransfer, expected] of [
    [fresh, state('verifying'), ['status', 'run', 'status', 'verify:activate', 'status']],
    [state('copying'), state('verifying'), ['status', 'resume', 'status', 'verify:activate', 'status']],
    [state('verifying', 'activating', true), null, ['status', 'verify:activate', 'status']],
    [state('activated', 'activating', true), null, ['status', 'verify:activate', 'status']],
    [activated, null, ['status']],
  ] as const) {
    let current: unknown = initial;
    const calls: string[] = [];
    await completeCommonImport(operationId, source, async (action, activate) => {
      calls.push(activate ? `${action}:activate` : action);
      if (action === 'run' || action === 'resume') current = afterTransfer;
      if (action === 'verify') current = activated;
      return current;
    });
    assert.deepEqual(calls, expected);
  }
});

test('refuses mismatched, abandoned, or unreconciled state without attempting activation', async () => {
  for (const invalid of [
    state('abandoned'),
    state('copying', 'rolling-back'),
    state('activated', 'activated', false),
    { ...state('copying'), run: { ...state('copying').run, operationId: 'other' } },
    { ...state('copying'), run: { ...state('copying').run, source: { ...source, version: 'other' } } },
    { run: state('copying').run, execution: null },
  ]) {
    const calls: string[] = [];
    await assert.rejects(
      completeCommonImport(operationId, source, async (action) => {
        calls.push(action);
        return invalid;
      }),
      /import_common_status_unexpected/,
    );
    assert.deepEqual(calls, ['status']);
  }
});

test('requires durable activation readback even when verify returns success', async () => {
  const calls: string[] = [];
  await assert.rejects(
    completeCommonImport(operationId, source, async (action) => {
      calls.push(action);
      return state('verifying');
    }),
    /import_common_status_unexpected/,
  );
  assert.deepEqual(calls, ['status', 'verify', 'status']);
});

test('rollback reconciles interrupted transfers before allowing recovery', async () => {
  for (const initial of [state('copying'), state('verifying', 'rolling-back'), state('abandoned')]) {
    let current = initial;
    const calls: string[] = [];
    await rollbackCommonImport(operationId, source, async (action) => {
      calls.push(action);
      if (action === 'rollback') current = state('abandoned');
      return current;
    });
    assert.deepEqual(calls, initial.run.status === 'abandoned' ? ['status'] : ['status', 'rollback', 'status']);
  }
});

test('rollback refuses after writer intent and requires a retained abandonment receipt', async () => {
  for (const [initial, expected] of [
    [state('verifying', 'activating', true), ['status']],
    [state('copying'), ['status', 'rollback', 'status']],
  ] as const) {
    const calls: string[] = [];
    await assert.rejects(
      rollbackCommonImport(operationId, source, async (action) => {
        calls.push(action);
        return initial;
      }),
      /import_common_status_unexpected/,
    );
    assert.deepEqual(calls, expected);
  }
});
