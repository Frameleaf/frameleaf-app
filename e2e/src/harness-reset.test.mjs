import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertResetExecutionsStopped, drainAfterExecutorStop } from './harness-reset-executions.mjs';
import { resetWhilePaused } from './harness-reset.ts';
import { waitUntil, withDeadline } from './harness-wait.ts';

test('configuration reset authenticates without existing work, then drains admitted jobs before mutation', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  drainQueues: async'), source.indexOf('\n\n  resetDatabase:'))
    .trim()
    .replace(/^drainQueues: /, '')
    .replace(/,$/, '');
  const order = [];
  let unfinished = false;
  let paused = false;
  let blocker;
  const bindings = {
    pg: {
      Client: class {
        on() {
          return this;
        }
        async connect() {}
        async query(text) {
          if (text.includes("SELECT 'attempt' AS kind")) return { rows: blocker ? [blocker] : [] };
          if (text === 'UPDATE job_queue SET paused = true') paused = true;
          if (text.includes('INSERT INTO "user"')) order.push('owned-admin');
          if (text.includes('DELETE FROM "user"')) order.push('cleaned-admin');
          if (text.includes('UPDATE job_queue q SET paused')) {
            paused = false;
            order.push('restored');
          }
          if (text.includes('unfinished')) return { rows: [{ unfinished: false }] };
          return { rows: [] };
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
    cancelMediaOperation: async () => assert.fail('no media work was admitted'),
    readQueues: async () => [{ name: 'metadata', hasUnfinishedWork: unfinished, statistics: { failed: 0 } }],
    emptyQueue: async () => {
      assert.equal(paused, true);
      unfinished = false;
      order.push('drained-config-work');
    },
    utils: {
      resetAdminConfig: async (token, signal) => {
        assert.ok(token);
        assert.ok(signal instanceof AbortSignal);
        assert.equal(paused, true);
        order.push('config');
        unfinished = true;
      },
    },
    ownedWait: withDeadline,
    withDeadline,
    resetWhilePaused,
    waitUntil,
    drainAfterExecutorStop,
    assertResetExecutionsStopped,
  };
  const makeDrain = () =>
    new Function(
      'bindings',
      `const { ${Object.keys(bindings).join(', ')} } = bindings;
    let resetting = false; let resetFailure; return (${stripTypeScriptTypes(expression)});`,
    )(bindings);
  await makeDrain()(
    async () => {
      assert.equal(paused, true);
      assert.equal(unfinished, false);
      order.push('mutated');
    },
    undefined,
    true,
  );
  assert.deepEqual(order, [
    'owned-admin',
    'config',
    'drained-config-work',
    'mutated',
    'cleaned-admin',
    'restored',
    'closed',
  ]);
  for (const failure of ['configuration API', 'retained execution']) {
    order.length = 0;
    bindings.utils.resetAdminConfig = async () => {
      if (failure === 'configuration API') throw new Error('configuration refused');
      blocker = { kind: 'operation', id: 'new-config-work', active: false };
    };
    await assert.rejects(
      makeDrain()(async () => assert.fail('unsafe reset mutated data'), undefined, true),
      /Reset failed/,
    );
    assert.deepEqual(order, ['owned-admin', 'cleaned-admin', 'restored', 'closed']);
    assert.equal(paused, false);
    blocker = undefined;
  }
  const owner = new AbortController();
  let joinedSignal;
  bindings.utils.resetAdminConfig = async (_, signal) => {
    joinedSignal = signal;
    owner.abort(new Error('configuration reset cancelled'));
    await sleep(1000, undefined, { signal });
  };
  order.length = 0;
  await assert.rejects(
    makeDrain()(async () => assert.fail('cancelled reset mutated data'), owner.signal, true),
    /Reset failed/,
  );
  assert.equal(joinedSignal.aborted, true);
  assert.deepEqual(order, ['owned-admin', 'cleaned-admin', 'restored', 'closed']);
});

test('only metadata resets request configuration reconciliation and never delete its epoch pair', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  resetDatabase: async'), source.indexOf('\n\n  unzip:'))
    .trim()
    .replace(/^resetDatabase: /, '')
    .replace(/,$/, '');
  let resetConfig;
  let deletedMetadata;
  let rollback = false;
  let failDelete = false;
  const utils = {
    drainQueues: async (mutate, signal, config) => {
      resetConfig = config;
      await mutate(
        {
          query: async (text, values) => {
            if (text.startsWith('DELETE FROM system_metadata')) deletedMetadata = values[0];
            if (text === 'ROLLBACK') rollback = true;
            if (failDelete && text.startsWith('DELETE FROM "')) throw new Error('fixture delete failed');
          },
        },
        { remaining: () => 1000, signal },
      );
    },
  };
  const reset = new Function('utils', `return (${stripTypeScriptTypes(expression)});`)(utils);
  await reset(['asset']);
  assert.equal(resetConfig, false);
  assert.equal(deletedMetadata, undefined);
  await reset(['system_metadata']);
  assert.equal(resetConfig, true);
  for (const key of ['system-config', 'effective-config-epoch', 'server-id', 'media-location'])
    assert.equal(deletedMetadata.includes(key), false);
  failDelete = true;
  await assert.rejects(reset(['asset']), /fixture delete failed/);
  assert.equal(rollback, true);
});

test('authenticated defaults and update both join the original abort signal', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  resetAdminConfig: async'), source.indexOf('\n\n  isQueueEmpty:'))
    .trim()
    .replace(/^resetAdminConfig: /, '')
    .replace(/,$/, '');
  const signal = new AbortController().signal;
  const defaults = { trash: { enabled: true } };
  const headers = { authorization: 'owned-fixture' };
  const calls = [];
  const reset = new Function(
    'getConfigDefaults',
    'updateConfig',
    'asBearerAuth',
    'getConfigCredentials',
    'deleteConfigCredential',
    'getRemoteAccess',
    'updateRemoteAccess',
    'removeRemoteHostname',
    `return (${stripTypeScriptTypes(expression)});`,
  )(
    async (options) => {
      calls.push('defaults');
      assert.equal(options.signal, signal);
      assert.equal(options.headers, headers);
      return defaults;
    },
    async (body, options) => {
      calls.push('update');
      assert.equal(body.adminConfigDto, defaults);
      assert.equal(options.signal, signal);
      assert.equal(options.headers, headers);
    },
    () => headers,
    async () => [],
    async () => assert.fail('no configured credential'),
    async () => ({ customHostname: null }),
    async () => assert.fail('no remote defaults'),
    async () => assert.fail('no hostname'),
  );
  await reset('owned-admin', signal);
  assert.deepEqual(calls, ['defaults', 'update']);
});

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

test('fixture defaults explicitly clear owned credentials and protected remote settings through authenticated APIs', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  resetAdminConfig: async'), source.indexOf('\n\n  isQueueEmpty:'))
    .trim()
    .replace(/^resetAdminConfig: /, '')
    .replace(/,$/, '');
  const signal = new AbortController().signal,
    headers = { authorization: 'owned' },
    calls = [];
  const defaults = {
    frameleafCloud: {
      remoteAccess: { enabled: false, mode: 'relay', directPort: 2443, portMapping: true, publicUrl: 'frameleaf' },
    },
  };
  const opts = (o) => {
    assert.equal(o.signal, signal);
    assert.equal(o.headers, headers);
  };
  const bindings = {
    asBearerAuth: () => headers,
    getConfigDefaults: async (o) => {
      opts(o);
      return defaults;
    },
    updateConfig: async (b, o) => {
      opts(o);
      calls.push('defaults');
    },
    getConfigCredentials: async (o) => {
      opts(o);
      return [
        { name: 'oauth-client-secret', configured: true },
        { name: 'smtp-password', configured: false },
      ];
    },
    deleteConfigCredential: async ({ name }, o) => {
      opts(o);
      assert.equal(name, 'oauth-client-secret');
      calls.push('clear-owned-credential');
    },
    getRemoteAccess: async (o) => {
      opts(o);
      return {
        enabled: false,
        mode: 'relay-and-direct',
        directPort: 3222,
        portMapping: false,
        publicUrlChoice: 'custom',
        customHostname: 'owned.example.invalid',
      };
    },
    removeRemoteHostname: async (o) => {
      opts(o);
      calls.push('clear-owned-hostname');
    },
    updateRemoteAccess: async ({ remoteAccessUpdateDto }, o) => {
      opts(o);
      assert.deepEqual(remoteAccessUpdateDto, defaults.frameleafCloud.remoteAccess);
      calls.push('reset-remote');
    },
  };
  const reset = new Function(
    'bindings',
    `const {${Object.keys(bindings).join(',')}}=bindings;return (${stripTypeScriptTypes(expression)});`,
  )(bindings);
  await reset('fixture-admin', signal);
  assert.deepEqual(calls, ['defaults', 'clear-owned-credential', 'clear-owned-hostname', 'reset-remote']);
});
