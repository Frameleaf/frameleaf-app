import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertResetExecutionsStopped, drainAfterExecutorStop } from './harness-reset-executions.mjs';
import { resetLockSettings, resetWhilePaused } from './harness-reset.ts';
import { waitUntil, withDeadline } from './harness-wait.ts';

test('reset joins unsafe edits while preserving bounded refusals and cleanup', async (t) => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  drainQueues: async'), source.indexOf('\n\n  resetDatabase:'))
    .trim()
    .replace(/^drainQueues: /, '')
    .replace(/,$/, '');
  const cases = [
    ...['photo_edit', 'video_edit', 'video_export'].map((edit) => ({ name: edit, edit, behavior: 'retry' })),
    { name: 'unfinished edit hits the owned deadline', edit: 'video_edit', behavior: 'deadline' },
    { name: 'originally paused work is never resumed', edit: 'video_edit', behavior: 'paused' },
    { name: 'owner abort is joined', edit: 'video_edit', behavior: 'abort' },
    { name: 'photo versions retain API cancellation', edit: 'photo_version', behavior: 'cancel' },
    { name: 'queued-to-claimed refusal remains fatal', edit: 'video_edit', behavior: 'race' },
    { name: 'unexpected authentication refusal remains fatal', edit: 'photo_version', behavior: 'auth' },
    { name: 'retained executor-stop refusal remains fatal', edit: 'photo_version', behavior: 'stop' },
    { name: 'restoration error is reported after genuine quiescence', edit: 'video_edit', behavior: 'cleanup' },
  ];
  for (const { name, edit, behavior } of cases) {
    await t.test(name, async () => {
      let reads = 0;
      let settled = false;
      let paused = behavior === 'paused';
      const initiallyPaused = paused;
      const owner = new AbortController();
      const order = [];
      const operation = {
        id: 'started-edit',
        ownerId: 'owner',
        kind: 'quick_edit',
        settings: { edit },
        status: behavior === 'race' ? 'queued' : 'rendering',
        claimed: behavior !== 'race',
        remotePending: false,
        cancelRequestedAt: null,
      };
      const bindings = {
        pg: {
          Client: class {
            on() {
              return this;
            }
            async connect() {}
            async query(text) {
              if (text.includes("SELECT 'attempt' AS kind")) {
                return { rows: behavior === 'stop' ? [{ kind: 'operation', id: operation.id, active: false }] : [] };
              }
              if (text === 'SELECT name, paused FROM job_queue ORDER BY name FOR UPDATE') {
                return { rows: [{ name: 'videoConversion', paused }] };
              }
              if (text === 'UPDATE job_queue SET paused = true') {
                if (edit !== 'photo_version' && behavior !== 'race') {
                  assert.equal(settled, true, 'a retry must remain runnable until the edit settles');
                }
                paused = true;
                order.push('paused');
              }
              if (text.startsWith('UPDATE job SET') && edit !== 'photo_version' && behavior !== 'race') {
                assert.equal(settled, true, 'the running edit must not receive blanket job cancellation');
              }
              if (text.includes('UPDATE job_queue q SET paused')) {
                if (behavior === 'cleanup') throw new Error('owned restoration failed');
                paused = initiallyPaused;
                order.push('restored');
              }
              if (text.includes('FROM media_operation')) {
                assert.match(text, /SELECT id, "ownerId", kind, settings, status/);
                reads++;
                if (behavior === 'abort' && reads === 2) owner.abort(new Error('owned reset aborted'));
                if (behavior === 'race' && reads === 2) {
                  operation.status = 'rendering';
                  operation.claimed = true;
                }
                if (behavior === 'retry' || behavior === 'cleanup') {
                  if (reads === 2) {
                    operation.status = 'queued';
                    operation.claimed = false;
                  } else if (reads === 3) {
                    operation.status = 'rendering';
                    operation.claimed = true;
                  } else if (reads === 4) operation.status = 'completed';
                  else if (reads === 5) {
                    operation.claimed = false;
                    operation.remotePending = true;
                  } else if (reads === 6) {
                    assert.equal(paused, false);
                    settled = true;
                    order.push('settled');
                  }
                }
                return { rows: settled ? [] : [operation] };
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
        cancelMediaOperation: async () => {
          order.push('cancel');
          assert.equal(paused, true);
          if (behavior === 'race') throw new Error('400: started edit cannot be cancelled');
          if (behavior === 'auth') throw new Error('401: owner authentication refused');
          assert.equal(edit, 'photo_version', 'started unsafe edits must not reach API cancellation');
          settled = true;
        },
        readQueues: async () => [],
        ownedWait: (description, timeout, run, signal) =>
          withDeadline(description, ['deadline', 'paused'].includes(behavior) ? 80 : timeout, run, signal),
        withDeadline,
        resetWhilePaused,
        waitUntil,
        drainAfterExecutorStop,
        assertResetExecutionsStopped,
      };
      const drain = new Function(
        'bindings',
        `
        const { ${Object.keys(bindings).join(', ')} } = bindings;
        let resetting = false; let resetFailure;
        return (${stripTypeScriptTypes(expression)});
      `,
      )(bindings);
      const mutation = async () => {
        assert.equal(settled, true);
        assert.equal(paused, true);
        order.push('mutated');
      };
      if (behavior === 'retry' || behavior === 'cancel') {
        await drain(mutation, owner.signal);
        assert.deepEqual(
          order,
          behavior === 'retry'
            ? ['settled', 'paused', 'mutated', 'restored', 'closed']
            : ['paused', 'cancel', 'mutated', 'restored', 'closed'],
        );
      } else {
        let failure;
        await assert.rejects(drain(mutation, owner.signal), (error) => {
          failure = error;
          return /Reset failed/.test(error.message);
        });
        assert.equal(order.includes('mutated'), behavior === 'cleanup');
        assert.equal(order.at(-1), 'closed');
        if (['deadline', 'paused', 'abort'].includes(behavior)) {
          assert.deepEqual(order, ['closed']);
          assert.equal(paused, initiallyPaused);
        }
        if (behavior === 'abort') assert.equal(owner.signal.aborted, true);
        if (behavior === 'race' || behavior === 'auth') {
          assert.deepEqual(order, ['paused', 'cancel', 'restored', 'closed']);
          assert.match(failure.cause.cause.message, behavior === 'race' ? /400/ : /401/);
        }
        if (behavior === 'stop') {
          assert.deepEqual(order, ['paused', 'cancel', 'restored', 'closed']);
          assert.match(failure.cause.message, /executor stop is unconfirmed/);
        }
        if (behavior === 'cleanup') assert.match(failure.cause.message, /owned restoration failed/);
      }
    });
  }
});

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
  const reset = new Function('utils', 'resetLockSettings', `return (${stripTypeScriptTypes(expression)});`)(
    utils,
    resetLockSettings,
  );
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

test('fixture TRUNCATE checks for a blocking autovacuum well inside its statement timeout', () => {
  for (const budget of [1000, 400, 40, 3, 1]) {
    const { text, values } = resetLockSettings(budget);
    const settings = new Map();
    for (const [, name, index] of text.matchAll(/set_config\('(\w+)', \$(\d+), true\)/g)) {
      settings.set(name, values[Number(index) - 1]);
    }
    assert.equal(settings.get('statement_timeout'), `${budget}ms`);
    assert.equal(settings.get('lock_timeout'), `${budget}ms`);
    // Postgres cancels an autovacuum worker that blocks a lock only once the waiter's deadlock_timeout
    // (default 1 s) expires; a statement timeout of 1 s fires first, so the reset failed instead.
    const deadlock = Number.parseInt(settings.get('deadlock_timeout'), 10);
    assert.ok(deadlock >= 1 && deadlock <= 100, `deadlock_timeout ${deadlock}ms`);
    assert.ok(budget === 1 || deadlock < budget, `deadlock_timeout ${deadlock}ms within ${budget}ms`);
  }
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const reset = source.slice(source.indexOf('\n  resetDatabase: async'), source.indexOf('\n  unzip: async'));
  const settings = reset.indexOf('resetLockSettings(');
  assert.ok(settings > 0 && settings < reset.indexOf('TRUNCATE'), 'reset applies the lock settings before TRUNCATE');
});

test('active-job cancellation retries only confirmed statement-timeout row contention within reset ownership', async (t) => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const expression = source
    .slice(source.indexOf('  drainQueues: async'), source.indexOf('\n\n  resetDatabase:'))
    .trim()
    .replace(/^drainQueues: /, '')
    .replace(/,$/, '');
  const contention = {
    code: '57014',
    message: 'canceling statement due to statement timeout',
    where: 'waiting for ShareLock on transaction 42\nwhile updating tuple (1,2) in relation "job"',
  };
  const cases = [
    {
      name: 'single transient contention reaches stop proof before mutation',
      behavior: 'transient',
      error: contention,
    },
    { name: 'persistent contention expires and latches without mutation', behavior: 'persistent', error: contention },
    { name: 'owner abort after contention never retries or mutates', behavior: 'abort', error: contention },
    {
      name: 'fatal SQL failure is immediate',
      behavior: 'fatal',
      error: { code: '40001', message: 'serialization failure' },
    },
    {
      name: 'user cancellation is fatal',
      behavior: 'fatal',
      error: { ...contention, message: 'canceling statement due to user request' },
    },
    { name: 'timeout without row contention is fatal', behavior: 'fatal', error: { ...contention, where: undefined } },
    {
      name: 'other relation contention is fatal',
      behavior: 'fatal',
      error: { ...contention, where: contention.where.replace('"job"', '"asset"') },
    },
    { name: 'cleanup failure preserves the cancellation failure', behavior: 'cleanup', error: contention },
  ];
  for (const { name, behavior, error } of cases) {
    await t.test(name, async () => {
      const original = Object.assign(new Error(error.message), error);
      const cleanupError = new Error('owned restoration failed');
      const owner = new AbortController();
      const order = [];
      let cancellationAttempts = 0;
      let connections = 0;
      let mutationCount = 0;
      let caughtWaitError;
      const bindings = {
        pg: {
          Client: class {
            on() {
              return this;
            }
            async connect() {
              connections++;
            }
            async query(text, values) {
              if (text.startsWith('UPDATE job SET')) {
                cancellationAttempts++;
                order.push('cancel');
                if (behavior !== 'transient' || cancellationAttempts === 1) {
                  if (behavior === 'abort') queueMicrotask(() => owner.abort(new Error('owner cancelled reset')));
                  throw original;
                }
              }
              if (text === 'UPDATE job_queue SET paused = true') order.push('paused');
              if (text.includes('UPDATE job_queue q SET paused')) {
                order.push('restored');
                assert.deepEqual(JSON.parse(values[0]), [{ name: 'metadata', paused: true }]);
                if (behavior === 'cleanup') throw cleanupError;
              }
              if (text.includes("SELECT 'attempt' AS kind")) order.push('stop-proof');
              if (text.includes('SELECT name, paused')) return { rows: [{ name: 'metadata', paused: true }] };
              if (text.includes(' unfinished')) return { rows: [{ unfinished: false }] };
              return { rows: [] };
            }
            async end() {
              order.push('closed');
            }
          },
        },
        dbUrl: 'synthetic-owned-reset',
        // Shorten only this fake reset's owner deadline, leaving real query, poll and cleanup code intact.
        ownedWait: (description, timeout, operation, signal) => {
          assert.equal(timeout, 8000);
          return withDeadline(description, 300, operation, signal);
        },
        withDeadline,
        waitUntil: async (...arguments_) => {
          try {
            return await waitUntil(...arguments_);
          } catch (error) {
            caughtWaitError = error;
            throw error;
          }
        },
        resetWhilePaused,
        drainAfterExecutorStop,
        assertResetExecutionsStopped,
      };
      const drain = new Function(
        'bindings',
        `const { ${Object.keys(bindings).join(', ')} } = bindings;
         let resetting = false; let resetFailure; return (${stripTypeScriptTypes(expression)});`,
      )(bindings);
      const mutate = async () => {
        mutationCount++;
        order.push('mutated');
      };
      if (behavior === 'transient') {
        await drain(mutate, owner.signal);
        assert.equal(cancellationAttempts, 2);
        assert.deepEqual(order, [
          'paused',
          'cancel',
          'cancel',
          'stop-proof',
          'stop-proof',
          'mutated',
          'restored',
          'closed',
        ]);
        assert.equal(mutationCount, 1);
      } else {
        let failure;
        await assert.rejects(drain(mutate, owner.signal), (error) => {
          failure = error;
          return /Reset failed: lastControlPhase=request active-job cancellation/.test(error.message);
        });
        assert.equal(mutationCount, 0);
        assert.equal(order.includes('stop-proof'), false);
        assert.deepEqual(order.slice(-2), ['restored', 'closed']);
        if (behavior === 'persistent') {
          assert.ok(cancellationAttempts >= 2 && cancellationAttempts <= 3);
          assert.ok(failure.cause instanceof AggregateError);
          assert.equal(failure.cause.cause, caughtWaitError);
          assert.deepEqual(failure.cause.errors, [caughtWaitError, original]);
        } else {
          if (behavior === 'cleanup') {
            assert.ok(cancellationAttempts >= 2 && cancellationAttempts <= 3);
          } else {
            assert.equal(cancellationAttempts, 1);
          }
          if (behavior === 'abort') {
            assert.equal(caughtWaitError, owner.signal.reason);
            assert.equal(failure.cause.cause, caughtWaitError);
            assert.deepEqual(failure.cause.errors, [caughtWaitError, original]);
          } else if (behavior === 'cleanup') {
            assert.ok(failure.cause instanceof AggregateError);
            assert.equal(failure.cause.errors[0].cause, caughtWaitError);
            assert.deepEqual(failure.cause.errors[0].errors, [caughtWaitError, original]);
            assert.equal(failure.cause.errors[1], cleanupError);
          } else {
            assert.equal(failure.cause, original);
          }
        }
        const attemptsAtFailure = cancellationAttempts;
        await assert.rejects(
          drain(mutate),
          (error) => error.message === 'Previous database reset did not settle safely' && error.cause === failure,
        );
        assert.equal(connections, 1);
        assert.equal(cancellationAttempts, attemptsAtFailure);
      }
    });
  }
});
