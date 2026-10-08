import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventJournal, pollRequest, requestOnce, waitUntil, withDeadline } from './harness-wait.ts';

test('job admission refuses an aborted owner and binds the admitted request signal', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  createJob: async');
  const end = source.indexOf('\n\n  queueCommand:', start);
  assert.ok(start >= 0 && end > start);
  const admission = source
    .slice(start, end)
    .trim()
    .replace(/^createJob: /, '')
    .replace(/,$/, '');
  const owner = new AbortController();
  let calls = 0;
  const create = new Function(
    'ownedWait',
    'queueWaitTimeout',
    'createJob',
    'asBearerAuth',
    stripTypeScriptTypes(`function bind() { return (${admission}); }`) + '\nreturn bind();',
  )(
    (description, timeout, operation) => withDeadline(description, timeout, operation, owner.signal),
    () => 100,
    async (_, { signal }) => {
      calls++;
      assert.equal(signal.aborted, false);
      return 'admitted';
    },
    () => ({}),
  );
  assert.equal(await create('token', { name: 'integrity' }), 'admitted');
  owner.abort(new Error('test expired'));
  await assert.rejects(create('token', { name: 'integrity' }), /test expired/);
  assert.equal(calls, 1);
});

test('integrity fixture restoration joins admitted work and latches uncertain settlement', async () => {
  const source = readFileSync(new URL('./specs/server/api/integrity.e2e-spec.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  afterEach(async ({ signal }) => {');
  const end = source.indexOf("\n\n  describe('GET /runs", start);
  assert.ok(start >= 0 && end > start);
  for (const failurePhase of ['settlement', 'restoration']) {
    let restore;
    let restorationFailure;
    const joined = Promise.withResolvers();
    let settlement = joined.promise;
    const calls = [];
    new Function(
      'afterEach',
      'utils',
      'withDeadline',
      'QueueName',
      'admin',
      'runIntegrityFixtureCommand',
      `let fixtureRestorationFailed = false; let fixtureRestorationFailure; ${source.slice(start, end)}`,
    )(
      (callback) => {
        restore = callback;
      },
      {
        settlePendingWaits: async () => {},
        waitForQueue: () => settlement,
      },
      withDeadline,
      { IntegrityCheck: 'integrity' },
      { accessToken: 'token', userId: 'fixture' },
      async (context, args) => {
        context.remaining();
        calls.push(args[0]);
        if (restorationFailure && args[0] === 'cp') throw restorationFailure;
      },
    );
    const pending = restore({ signal: new AbortController().signal });
    assert.deepEqual(calls, []);
    joined.resolve();
    await pending;
    assert.deepEqual(calls, ['rm', 'cp']);
    const failure = new Error('settlement uncertain');
    settlement = failurePhase === 'settlement' ? Promise.reject(failure) : Promise.resolve();
    restorationFailure = failurePhase === 'restoration' ? failure : undefined;
    await assert.rejects(restore({ signal: new AbortController().signal }), /settlement uncertain/);
    await assert.rejects(restore({ signal: new AbortController().signal }), /settlement uncertain/);
    assert.deepEqual(calls, failurePhase === 'settlement' ? ['rm', 'cp'] : ['rm', 'cp', 'rm', 'cp']);
  }
});

test('integrity native fixture command requires confirmed close and rejects nonzero completion', async () => {
  const source = readFileSync(new URL('./specs/server/api/integrity.e2e-spec.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const runIntegrityFixtureCommand =');
  const end = source.indexOf("\n\ndescribe('/admin/integrity'", start);
  assert.ok(start >= 0 && end > start);
  let close;
  let data;
  let spawns = 0;
  const command = new Function(
    'spawn',
    'randomUUID',
    'process',
    stripTypeScriptTypes(`function bind() { ${source.slice(start, end)} return runIntegrityFixtureCommand; }`) +
      '\nreturn bind();',
  )(
    () => {
      spawns++;
      return {
        stdout: {
          setEncoding() {},
          on(_, callback) {
            data = callback;
          },
        },
        once(event, callback) {
          if (event === 'close') close = callback;
        },
      };
    },
    () => 'marker',
    {
      kill() {
        assert.fail('confirmed completion must not quarantine');
      },
    },
  );
  let settled = false;
  const pending = command({ remaining: () => 8000 }, ['cp'], 'Safe restoration failure');
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  data('FL333_INTEGRITY_DONE_marker:1\n');
  await Promise.resolve();
  assert.equal(settled, false);
  close(1, null);
  await assert.rejects(pending, /^Error: Safe restoration failure$/);
  await assert.rejects(
    command({ remaining: () => 3000 }, ['rm'], 'Safe deletion failure'),
    /without a complete native stop budget/,
  );
  assert.equal(spawns, 1);
});

test('reset reads all queues in one request and refuses incomplete or invalid aggregate status', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const readQueues =');
  const end = source.indexOf('\nconst waitForQueue =', start);
  assert.ok(start >= 0 && end > start);
  const names = Array.from({ length: 25 }, (_, index) => `queue-${index}`);
  const queues = names.map((name, index) => ({ name, hasUnfinishedWork: index === 24 }));
  let response = queues;
  let calls = 0;
  let failure;
  const readQueues = new Function(
    'getQueues',
    'QueueName',
    'asBearerAuth',
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn readQueues;`,
  )(
    ({ signal }) => {
      calls++;
      assert.equal(signal.aborted, false);
      return failure ? Promise.reject(failure) : Promise.resolve(response);
    },
    Object.fromEntries(names.map((name) => [name, name])),
    (token) => ({ Authorization: `Bearer ${token}` }),
  );
  const read = () => withDeadline('reset queue snapshot', 1_000, (context) => readQueues('token', context));
  assert.deepEqual(await read(), queues);
  assert.equal(calls, 1);
  assert.equal(
    queues.some((queue) => queue.hasUnfinishedWork),
    true,
  );
  for (const invalid of [
    queues.slice(1),
    [...queues.slice(1), queues[1]],
    queues.map((queue, index) => (index === 24 ? { name: queue.name } : queue)),
    queues.map((queue, index) => (index === 24 ? { ...queue, hasUnfinishedWork: 'false' } : queue)),
    null,
  ]) {
    response = invalid;
    await assert.rejects(read(), /Queues did not report complete authoritative unfinished work/);
  }
  failure = new Error('aggregate transport failed');
  await assert.rejects(read(), (error) => error === failure);
});

test('reset skips only empty clean queues and rechecks periodic work without bypassing privacy or failures', async () => {
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const headers = asBearerAuth(token);', source.indexOf('drainQueues:'));
  const tail = 'return operations.length > 0;';
  const end = source.indexOf(tail, start) + tail.length;
  assert.ok(start >= 0 && end > start);
  const idle = { name: 'idle', hasUnfinishedWork: false, statistics: { failed: 0 } };
  const live = { ...idle, name: 'live', hasUnfinishedWork: true };
  const failed = { ...idle, name: 'failed', statistics: { failed: 1 } };
  const privateQueue = { ...idle, name: 'private' };
  let snapshots = [[idle, live, failed, privateQueue], [idle]];
  let dirty = [{ queue: 'private' }];
  let failure;
  let reads = 0;
  const clears = [];
  const drain = new Function(
    'readQueues',
    'query',
    'emptyQueue',
    'unfinishedOperations',
    'asBearerAuth',
    `${stripTypeScriptTypes(`const drain = async (context) => {
      const token = 'token'; let phase; let lastUnfinished;
      ${source.slice(start, end)} };`)}\nreturn drain;`,
  )(
    (_token, context) => {
      context.remaining();
      reads++;
      return Promise.resolve(snapshots.shift());
    },
    (context, statement) => {
      context.remaining();
      assert.match(statement, /^SELECT DISTINCT queue FROM job_run_item/);
      assert.match(statement, /"jobId" IS NULL/);
      assert.match(statement, /"libraryIntent"->>'sensitive' = 'true'/);
      assert.match(statement, /"libraryIntent" \? 'options' OR "libraryIntent"->'data' != '\{\}'::jsonb/);
      return failure ? Promise.reject(failure) : Promise.resolve({ rows: dirty });
    },
    ({ name, queueDeleteDto }, { signal }) => {
      assert.equal(signal.aborted, false);
      assert.deepEqual(queueDeleteDto, { failed: true });
      clears.push(name);
      return Promise.resolve();
    },
    () => Promise.resolve([]),
    () => ({}),
  );
  const run = () => withDeadline('selected reset queues', 1_000, drain);
  assert.equal(await run(), false);
  assert.deepEqual(clears, ['live', 'failed', 'private']);
  assert.equal(reads, 2);

  clears.length = 0;
  dirty = [];
  snapshots = [[idle], [{ ...idle, hasUnfinishedWork: true }]];
  assert.equal(await run(), true); // A periodic producer arrived after the initial snapshot.
  assert.deepEqual(clears, []);
  snapshots = [[{ ...idle, hasUnfinishedWork: true }], [idle]];
  assert.equal(await run(), false);
  assert.deepEqual(clears, ['idle']);

  clears.length = 0;
  snapshots = [[idle], [idle]];
  failure = new Error('privacy snapshot unavailable');
  const previousReads = reads;
  await assert.rejects(run(), (error) => error === failure);
  assert.deepEqual(clears, []);
  assert.equal(reads, previousReads + 1);
  failure = undefined;
  snapshots = [[{ ...idle, statistics: {} }], [idle]];
  assert.equal(await run(), false);
  assert.deepEqual(clears, ['idle']); // Unknown failed count cannot authorize skipping.
});

test('a failed queue joins remaining work before reporting the failure', async () => {
  // Exercise the actual predicate without loading the application SDK or runner fixtures.
  const source = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const waitForQueue =');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  let reads = 0;
  const waitForQueue = new Function(
    'waitUntil',
    'readQueue',
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn waitForQueue;`,
  )(waitUntil, async () => ({ hasUnfinishedWork: ++reads === 1, statistics: { failed: 1 } }));
  await assert.rejects(
    withDeadline('failed queue settlement', 1_000, (context) => waitForQueue('token', 'videoConversion', context)),
    /Queue videoConversion has 1 failed or blocked jobs/,
  );
  assert.equal(reads, 2);
});

test('a timeout aborts and settles its one request before returning, with no late validation or second poll', async () => {
  let reads = 0;
  let validations = 0;
  let settled = false;
  await assert.rejects(
    withDeadline('queue test', 20, (context) =>
      waitUntil(
        context,
        async ({ signal }) => {
          reads++;
          try {
            await sleep(1_000, undefined, { signal });
          } finally {
            settled = true;
          }
        },
        () => {
          validations++;
          return false;
        },
      ),
    ),
    /queue test timed out/,
  );
  assert.equal(settled, true);
  await sleep(30);
  assert.equal(reads, 1);
  assert.equal(validations, 0);
});

test('runner cancellation prevents accepting a late successful response', async () => {
  const controller = new AbortController();
  let validate = 0;
  const reason = new Error('test runner ended the test');
  await assert.rejects(
    withDeadline(
      'late success',
      1_000,
      (context) =>
        waitUntil(
          context,
          async () => {
            controller.abort(reason);
            return { complete: true };
          },
          () => {
            validate++;
            return true;
          },
        ),
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(validate, 0);
});

test('a request failure propagates without another read or a tight retry loop', async () => {
  const failure = new Error('SDK request failed with 500');
  let reads = 0;
  await assert.rejects(
    withDeadline('failed request', 1_000, (context) =>
      waitUntil(
        context,
        async () => {
          reads++;
          throw failure;
        },
        () => true,
      ),
    ),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});

test('a restarting HTTP endpoint retries settled connection failures with a bounded cadence', async () => {
  let reads = 0;
  const times = [];
  const result = await withDeadline('restart', 1_000, (context) =>
    pollRequest(
      context,
      () => {
        reads++;
        times.push(performance.now());
        const pending =
          reads === 1
            ? Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
            : Promise.resolve({ status: 200 });
        return Object.assign(pending, { timeout: () => pending, abort: () => {} });
      },
      ({ status }) => status === 200,
      20,
    ),
  );
  assert.equal(result.status, 200);
  assert.equal(reads, 2);
  assert.ok(times[1] - times[0] >= 15);
});

test('HTTP server errors remain explicit instead of being swallowed as transient restart failures', async () => {
  const error = Object.assign(new Error('500 database capacity exhausted'), { status: 500 });
  let reads = 0;
  await assert.rejects(
    withDeadline('http error', 1_000, (context) =>
      pollRequest(
        context,
        () => {
          reads++;
          const pending = Promise.reject(error);
          return Object.assign(pending, { timeout: () => pending, abort: () => {} });
        },
        () => true,
      ),
    ),
    (caught) => caught === error,
  );
  assert.equal(reads, 1);
});

test('a mutating request never replays an ambiguous connection failure', async () => {
  const error = Object.assign(new Error('response lost after upload'), { code: 'ECONNRESET' });
  let requests = 0;
  await assert.rejects(
    withDeadline('upload', 1_000, (context) =>
      requestOnce(context, () => {
        requests++;
        const pending = Promise.reject(error);
        return Object.assign(pending, { timeout: () => pending, abort: () => {} });
      }),
    ),
    (caught) => caught === error,
  );
  assert.equal(requests, 1);
});

test('request timeout awaits abort settlement instead of leaving a late transport callback', async () => {
  let aborts = 0;
  let settled = false;
  await assert.rejects(
    withDeadline('request body', 20, (context) =>
      requestOnce(context, () => {
        let reject;
        const pending = new Promise((_, rejectRequest) => {
          reject = rejectRequest;
        });
        return Object.assign(pending, {
          timeout: () => pending,
          abort: () => {
            aborts++;
            setTimeout(() => {
              settled = true;
              reject(new Error('transport closed'));
            }, 10);
          },
        });
      }),
    ),
    /request body timed out/,
  );
  assert.equal(aborts, 1);
  assert.equal(settled, true);
});

test('a false predicate is bounded and the last late response cannot be accepted', async () => {
  let reads = 0;
  await assert.rejects(
    withDeadline('never ready', 25, (context) =>
      waitUntil(
        context,
        async () => {
          reads++;
          return false;
        },
        (value) => value,
        10,
      ),
    ),
    /never ready timed out/,
  );
  const readsAtTimeout = reads;
  await sleep(30);
  assert.equal(reads, readsAtTimeout);
  assert.ok(reads >= 1 && reads <= 3);
});

test('websocket waits are keyed by event and each same-ID waiter owns its cleanup', async () => {
  const journal = new EventJournal();
  const controller = new AbortController();
  const cancelled = journal.wait({ event: 'assetUpload', id: 'asset', signal: controller.signal });
  const kept = journal.wait({ event: 'assetUpload', id: 'asset' });
  controller.abort(new Error('old waiter cancelled'));
  await assert.rejects(cancelled, /old waiter cancelled/);
  journal.add('assetUpdate', 'asset');
  let done = false;
  void kept.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  journal.add('assetUpload', 'asset');
  await kept;
  assert.equal(done, true);
});

test('event reset rejects and unregisters ID and count waits without disturbing a later registration', async () => {
  const journal = new EventJournal();
  const byId = journal.wait({ event: 'assetDelete', id: 'asset' });
  const byCount = journal.wait({ event: 'assetDelete', total: 2 });
  journal.clear();
  await assert.rejects(byId, /Event history reset/);
  await assert.rejects(byCount, /Event history reset/);
  const later = journal.wait({ event: 'assetDelete', total: 2 });
  journal.add('assetDelete', 'one');
  journal.add('assetDelete', 'one');
  let done = false;
  void later.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  journal.add('assetDelete', 'two');
  await later;
});

test('invalid event wait arguments do not register a callback or accept an unrelated event', async () => {
  const journal = new EventJournal();
  await assert.rejects(journal.wait({ event: 'assetHidden' }), /positive count/);
  await assert.rejects(journal.wait({ event: 'assetHidden', id: 'asset', total: -1 }), /positive count/);
  const waiting = journal.wait({ event: 'assetHidden', id: 'asset' });
  journal.add('assetHidden', 'asset');
  await waiting;
});
