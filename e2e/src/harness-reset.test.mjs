import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertResetExecutionsStopped, drainAfterExecutorStop } from './harness-reset-executions.mjs';
import { resetWhilePaused } from './harness-reset.ts';
import { waitUntil, withDeadline } from './harness-wait.ts';

test('fixture mutation uses the overall reset budget after quiescence, and still joins cleanup', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  drainQueues: async');
  const end = source.indexOf('\n\n  resetDatabase:', start);
  assert.ok(start >= 0 && end > start);
  const expression = source
    .slice(start, end)
    .trim()
    .replace(/^drainQueues: /, '')
    .replace(/,$/, '');
  const order = [];
  let operation;
  let cancellationReason;
  const bindings = {
    pg: {
      Client: class {
        on() {
          return this;
        }
        async connect() {}
        async query(text) {
          if (text.includes('FROM media_operation')) {
            return { rows: operation ? [operation] : [] };
          }
          return { rows: text.startsWith('SELECT id FROM "user"') ? [{ id: 'owner' }] : [] };
        }
        async end() {
          order.push('closed');
        }
      },
    },
    dbUrl: 'owned-disposable-fixture',
    createHash,
    randomBytes,
    randomUUID,
    asBearerAuth: () => ({}),
    cancelMediaOperation: async (_, { signal }) => {
      try {
        await sleep(5000, undefined, { signal });
      } catch (error) {
        cancellationReason = signal.reason;
        throw error;
      }
    },
    readQueues: async () => [],
    ownedWait: (description, _timeout, operation, signal) => withDeadline(description, 1000, operation, signal),
    withDeadline: (description, timeout, operation, signal) =>
      withDeadline(description, description === 'Quiescing test database' ? 100 : timeout, operation, signal),
    resetWhilePaused,
    waitUntil,
    drainAfterExecutorStop,
    assertResetExecutionsStopped,
  };
  const bind = new Function(
    'bindings',
    `
    const { ${Object.keys(bindings).join(', ')} } = bindings;
    let resetting = false; let resetFailure;
    return (${stripTypeScriptTypes(expression)});
  `,
  );
  const drain = bind(bindings);
  await drain(async (_db, context) => {
    await sleep(150);
    context.remaining();
    order.push('mutated');
  });
  assert.deepEqual(order, ['mutated', 'closed']);
  const owner = new AbortController();
  const pending = drain(async (_db, context) => {
    owner.abort(new Error('reset owner cancelled'));
    context.remaining();
  }, owner.signal);
  await assert.rejects(pending, /Reset failed/, 'owner cancellation must still fail the overall reset');
  assert.deepEqual(order, ['mutated', 'closed', 'closed']);
  operation = { id: 'operation', ownerId: 'owner', status: 'running', cancelRequestedAt: null };
  await assert.rejects(
    bind(bindings)(async () => assert.fail('unsettled work must not mutate')),
    /Reset failed/,
  );
  assert.match(cancellationReason.message, /Quiescing test database timed out/);
  assert.deepEqual(order, ['mutated', 'closed', 'closed', 'closed']);
});

test('reset cannot mutate or resume until the last execution has settled', async () => {
  const order = [];
  let release;
  const stopped = new Promise((resolve) => {
    release = resolve;
  });
  const initial = [
    { name: 'metadata', paused: true },
    { name: 'background', paused: false },
  ];
  const work = resetWhilePaused({
    pause: async () => {
      order.push('paused');
      return initial;
    },
    drain: async () => {
      order.push('cancel-requested');
      await stopped;
      order.push('stopped');
    },
    mutate: async () => {
      order.push('mutated');
    },
    restore: async (snapshot) => {
      assert.equal(snapshot, initial);
      order.push('restored');
    },
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
  await assert.rejects(
    resetWhilePaused({
      pause: async () => [],
      drain: async () => {
        throw primary;
      },
      mutate: async () => {
        mutated = true;
      },
      restore: async () => {
        throw cleanup;
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, cleanup);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
  assert.equal(mutated, false);
});

test('a data mutation failure still restores the precise original queue states', async () => {
  const error = new Error('database rollback');
  const initial = [
    { name: 'metadata', paused: true },
    { name: 'background', paused: false },
  ];
  let restored;
  await assert.rejects(
    resetWhilePaused({
      pause: async () => initial,
      drain: async () => {},
      mutate: async () => {
        throw error;
      },
      restore: async (snapshot) => {
        restored = snapshot;
      },
    }),
    (caught) => caught === error,
  );
  assert.equal(restored, initial);
});
