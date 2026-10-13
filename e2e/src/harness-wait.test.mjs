import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventJournal, pollRequest, requestOnce, waitUntil, withDeadline } from './harness-wait.ts';

test('cloud accounting joins the exact post-commit release within its existing deadline', async () => {
  const source = readFileSync(new URL('./specs/cloud/cloud-accounting.spec.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    // Production cron and 60s poll delay are retained.');
  const end = source.indexOf('\n    const { body: enrichment }', start);
  assert.ok(start >= 0 && end > start);
  const release = Promise.withResolvers();
  let released = false;
  let settled = false;
  let providerReads = 0;
  const expect = (value) => ({
    toBe: (expected) => assert.equal(value, expected),
    toBeNull: () => assert.equal(value, null),
    toHaveLength: (expected) => assert.equal(value.length, expected),
    toMatchObject: (expected) => {
      for (const [key, item] of Object.entries(expected)) assert.deepEqual(value[key], item);
    },
  });
  const pending = new Function(
    'vi',
    'request',
    'app',
    'auth',
    'expect',
    'operationId',
    'providerState',
    `return (async () => {${source.slice(start, end)}})();`,
  )(
    {
      waitFor: async (check, options) => {
        assert.deepEqual(options, { timeout: 125_000, interval: 1000 });
        try {
          await check();
        } catch {
          await release.promise;
          await check();
        }
      },
    },
    () => ({
      get: () => ({
        set: () => ({
          expect: async () => ({
            body: {
              status: 'completed',
              processedUnits: '1',
              cloudJob: null,
            },
          }),
        }),
      }),
    }),
    'fixture',
    () => ({}),
    expect,
    'operation',
    async () => {
      providerReads++;
      return { lifecycle: { jobs: [{ clientRef: 'batch-operation', released }] } };
    },
  ).then(() => {
    settled = true;
  });
  await sleep(0);
  assert.equal(settled, false, 'operation completion is not provider release');
  released = true;
  release.resolve();
  await pending;
  assert.ok(providerReads >= 2);
});

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

// Execute the actual browser fixture setup and readiness implementation without a server.
const documentSource = readFileSync(new URL('./specs/web/documents.e2e-spec.ts', import.meta.url), 'utf8');
const setupStart = documentSource.indexOf('    const asset = await utils.createAsset');
const setupEnd = documentSource.indexOf('    await setupPinCode', setupStart);
assert.ok(setupStart >= 0 && setupEnd > setupStart);
const setup = new Function(
  'utils',
  'user',
  'admin',
  'headers',
  'PNG',
  'image',
  'suffix',
  'lockAssets',
  'assetReady',
  stripTypeScriptTypes(`function bind() { return async () => { ${documentSource.slice(setupStart, setupEnd)} }; }`) +
    '\nreturn bind();',
);
const utilsSource = readFileSync(new URL('./utils.ts', import.meta.url), 'utf8');
const readyStart = utilsSource.indexOf('  waitForAssetReady: async');
const readyEnd = utilsSource.indexOf('\n\n  poll:', readyStart);
assert.ok(readyStart >= 0 && readyEnd > readyStart);
const readiness = utilsSource
  .slice(readyStart, readyEnd)
  .trim()
  .replace(/^waitForAssetReady: /, '')
  .replace(/,$/, '');

for (const outcome of ['published', 'empty', 'wrong-kind', 'aborted']) {
  test(`document evidence waits for owner-readable preview before locking: ${outcome}`, async () => {
    const publication = Promise.withResolvers();
    const owner = new AbortController();
    const calls = [];
    const headers = { Authorization: 'Bearer owner' };
    const waitForAssetReady = new Function(
      'ownedWait',
      'queueWaitTimeout',
      'QueueName',
      'waitForQueue',
      'asBearerAuth',
      'getAssetInfo',
      'viewAsset',
      'AssetMediaSize',
      stripTypeScriptTypes(`function bind() { return (${readiness}); }`) + '\nreturn bind();',
    )(
      withDeadline,
      () => 1000,
      { MetadataExtraction: 'metadata', StorageTemplateMigration: 'storage', ThumbnailGeneration: 'thumbnail' },
      async (token, queue, context) => {
        assert.equal(token, 'admin');
        calls.push(queue);
        if (queue === 'thumbnail') {
          await Promise.race([
            publication.promise,
            new Promise((_, reject) =>
              context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }),
            ),
          ]);
        }
      },
      () => {
        throw new Error('Owner read headers required');
      },
      async ({ id }, options) => {
        assert.equal(options.headers, headers);
        assert.equal(options.signal.aborted, false);
        calls.push('info');
        return { id };
      },
      async ({ id, size }, options) => {
        assert.equal(id, 'document');
        assert.equal(size, 'preview');
        assert.equal(options.headers, headers);
        calls.push('preview');
        return {
          size: outcome === 'empty' ? 0 : 12,
          type: outcome === 'wrong-kind' ? 'application/json' : 'image/jpeg',
        };
      },
      { Preview: 'preview' },
    );
    const run = setup(
      {
        createAsset: async (token) => {
          assert.equal(token, 'owner');
          calls.push('upload');
          return { id: 'document' };
        },
        waitForAssetReady,
      },
      { accessToken: 'owner' },
      { accessToken: 'admin' },
      headers,
      { sync: { write: () => new Uint8Array([1]) } },
      {},
      'fixture',
      async (body, options) => {
        assert.deepEqual(body, { bulkIdsDto: { ids: ['document'] } });
        assert.equal(options.headers, headers);
        calls.push('lock');
      },
      { signal: owner.signal },
    );
    const pending = run();
    // Attach rejection handling before cancellation, then let admission reach the publication barrier.
    const settled = pending.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls.includes('lock'),
      false,
      'Upload acknowledgement must not admit locked evidence before publication',
    );
    if (outcome === 'aborted') owner.abort(new Error('fixture expired'));
    else publication.resolve();
    const result = await settled;
    if (outcome === 'published') {
      assert.equal(result.ok, true);
      assert.deepEqual(calls, ['upload', 'metadata', 'storage', 'thumbnail', 'info', 'preview', 'lock']);
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error.message, /Asset readiness failed/);
      assert.equal(calls.includes('lock'), false);
    }
  });
}

const source = readFileSync(new URL('./specs/web/performance-report.e2e-spec.ts', import.meta.url), 'utf8');
const referenceEnvironment = {
  model: 'Mac14,13',
  cpu: 'Apple M2 Max',
  memoryBytes: 34359738368,
  osVersion: '27.2',
  osBuild: '26B5101f',
  nodeVersion: 'v24.21.0',
  playwrightVersion: '1.62.1',
  browserVersion: '151.0.7922.34',
  power: 'AC',
  lowPowerMode: 0,
  viewportWidth: 1280,
  viewportHeight: 720,
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  cachePolicy: 'cold-context-warm-stack',
  generatorSha256: 'a'.repeat(64),
  fixturesSha256: 'b'.repeat(64),
  runtimeConfigSha256: 'c'.repeat(64),
  browserExecutableSha256: 'd'.repeat(64),
  dockerVersion: '29.8.2',
  dockerCpus: 12,
  dockerMemoryBytes: 8214585344,
};

const setupPerformanceFixture = (
  candidate = source,
  thumbnailDuration = 5_000,
  uniqueImages = true,
  uniqueIds = true,
  uploadDuration = 50,
  progressCreateFailure = false,
) => {
  let beforeAll;
  let hookTimeout;
  let elapsed = 0;
  let uploads = 0;
  const uploaded = [];
  const attachments = [];
  const progressWrites = [];
  const sdkDefaults = {};
  let generated = 0;
  const queues = [];
  const budgets = [];
  const runner = {
    describe: (_name, register) => register(),
    beforeAll: (callback) => (beforeAll = callback),
    setTimeout: (timeout) => (hookTimeout = timeout),
    info: () => ({
      outputPath: () => 'fixture-dataset-progress.ndjson',
      attach: async (name, options) => attachments.push({ name, body: JSON.parse(options.body) }),
    }),
  };
  const registerTest = Object.assign(() => {}, runner);
  const fixture = {
    initSdk: () => {},
    resetDatabase: async () => {},
    adminSetup: async () => ({ accessToken: 'fixture-token' }),
    createAsset: async (token, dto, options) => {
      uploads++;
      elapsed += uploadDuration;
      uploaded.push({ token, dto, options });
      return { id: `fixture-asset-${uniqueIds ? uploads : 1}`, status: 'created' };
    },
    waitForQueueFinish: async (token, queue, timeout = 60_000) => {
      assert.equal(token, 'fixture-token');
      queues.push(queue);
      budgets.push(timeout);
      // Exact failed x64 run: about 40 thumbnails per 70 seconds. Retain all 200;
      // model a healthy pipeline taking 350 seconds rather than sleeping in this control.
      const duration =
        queue === 'metadataExtraction' ? 350_000 : queue === 'thumbnailGeneration' ? thumbnailDuration : 5_000;
      if (duration > timeout) throw new Error('queue deadline');
      elapsed += duration;
      if (elapsed > hookTimeout) throw new Error('hook deadline');
    },
  };
  const script = stripTypeScriptTypes(candidate.replace(/^import .*;\n/gm, ''));
  const image = (width, height) => {
    assert.equal(width, 32);
    assert.equal(height, 32);
    generated++;
    return Buffer.from(`fixture-png-${uniqueImages ? generated : 1}`);
  };
  new Function(
    'test',
    'utils',
    'expect',
    'Date',
    'createHash',
    'makeRandomImage',
    'defaults',
    'writeFileSync',
    'appendFileSync',
    script,
  )(
    registerTest,
    fixture,
    () => {},
    { now: () => elapsed },
    createHash,
    image,
    sdkDefaults,
    (_path, body) => {
      if (progressCreateFailure) throw new Error('progress file exists');
      progressWrites.push(JSON.parse(body));
    },
    (_path, body) => progressWrites.push(JSON.parse(body)),
  );
  return {
    run: () => beforeAll({}),
    result: () => ({
      hookTimeout,
      elapsed,
      uploads,
      queues,
      budgets,
      uploaded,
      attachments,
      generated,
      progressWrites,
      sdkDefaults,
    }),
  };
};

test('200-image preparation has a finite caller budget for the measured healthy backlog', async () => {
  const fixture = setupPerformanceFixture();
  await fixture.run();
  const result = fixture.result();
  assert.equal(result.uploads, 200);
  assert.deepEqual(result.queues, ['metadataExtraction', 'storageTemplateMigration', 'thumbnailGeneration']);
  assert.deepEqual(result.budgets, [590_000, 240_000, 235_000]);
  assert.ok(result.elapsed > 120_000);
  assert.ok(result.hookTimeout >= result.elapsed && result.hookTimeout <= 600_000);
});

test('200-image preparation records reproducible bytes, dates and returned asset identities', async () => {
  const fixture = setupPerformanceFixture();
  await fixture.run();
  const result = fixture.result();
  assert.equal(result.generated, 200);
  assert.equal(result.uploaded.length, 200);
  for (const [index, upload] of result.uploaded.entries()) {
    assert.equal(upload.token, 'fixture-token');
    assert.equal(upload.dto.fileCreatedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(upload.dto.fileModifiedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(upload.dto.assetData.filename, 'example.png');
    assert.deepEqual(upload.dto.assetData.bytes, Buffer.from(`fixture-png-${index + 1}`));
  }
  const dataset = result.attachments.find((entry) => entry.name === 'performance-dataset.json')?.body;
  assert.ok(dataset, 'Missing prepared dataset evidence');
  assert.equal(dataset.complete, true);
  assert.equal(dataset.width, 32);
  assert.equal(dataset.height, 32);
  assert.equal(dataset.assets.length, 200);
  for (const [index, asset] of dataset.assets.entries()) {
    assert.equal(asset.assetId, `fixture-asset-${index + 1}`);
    assert.equal(
      asset.sourceSha256,
      createHash('sha256')
        .update(`fixture-png-${index + 1}`)
        .digest('hex'),
    );
  }
  assert.equal(new Set(dataset.assets.map((asset) => asset.sourceSha256)).size, 200);
});

test('200-image preparation rejects repeated source bytes', async () => {
  const fixture = setupPerformanceFixture(source, 5_000, false);
  await assert.rejects(fixture.run(), /Dataset has duplicate source bytes/);
  const dataset = fixture.result().attachments.find((entry) => entry.name === 'performance-dataset.json')?.body;
  assert.equal(dataset.complete, false);
  assert.equal(dataset.assets.length, 200);
});

test('200-image preparation rejects repeated returned asset identities', async () => {
  await assert.rejects(
    setupPerformanceFixture(source, 5_000, true, false).run(),
    /Dataset has duplicate asset identities/,
  );
});

test('the performance fixture control reproduces both original deadline failures', async () => {
  const shortQueue = source.replace(/, deadline - Date.now\(\)\);/g, ');');
  await assert.rejects(setupPerformanceFixture(shortQueue).run(), /queue deadline/);
  const shortHook = source.replace('test.setTimeout(PREPARATION_TIMEOUT)', 'test.setTimeout(120_000)');
  await assert.rejects(setupPerformanceFixture(shortHook).run(), /hook deadline/);
});

test('later performance preparation queues cannot extend the whole-hook deadline', async () => {
  await assert.rejects(setupPerformanceFixture(source, 250_000).run(), /queue deadline/);
});

test('performance measurement control rejects invalid timings and a workload that did not scroll', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const validate = new Function(
    'test',
    script + '\nreturn typeof validateMeasurements === "function" ? validateMeasurements : undefined;',
  )(register);
  assert.equal(typeof validate, 'function', 'Missing measurement validity check');
  const valid = {
    libraryItems: 200,
    startup: { domContentLoadedMs: 12, loadMs: 20 },
    firstThumbnailMs: 21,
    scroll: {
      frames: 59,
      longFrames: 0,
      medianFrameMs: 17,
      worstFrameMs: 20,
      diagnostics: { scrollHeight: 600, clientHeight: 100, start: 0, bottom: 500, back: 0 },
    },
  };
  assert.doesNotThrow(() => validate(valid));
  for (const path of [
    'startup.domContentLoadedMs',
    'startup.loadMs',
    'firstThumbnailMs',
    'scroll.longFrames',
    'scroll.medianFrameMs',
    'scroll.worstFrameMs',
  ]) {
    for (const value of [undefined, NaN, Infinity, -1]) {
      const report = structuredClone(valid);
      const keys = path.split('.');
      (keys.length === 1 ? report : report[keys[0]])[keys.at(-1)] = value;
      assert.throws(() => validate(report), /Invalid performance measurement/, `${path}: ${value}`);
    }
  }
  for (const change of [
    { libraryItems: 199 },
    { firstThumbnailMs: 0 },
    { scroll: { ...valid.scroll, frames: 0 } },
    { scroll: { ...valid.scroll, longFrames: 60 } },
    { scroll: { ...valid.scroll, diagnostics: undefined } },
    { scroll: { ...valid.scroll, diagnostics: { ...valid.scroll.diagnostics, bottom: 0 } } },
    { scroll: { ...valid.scroll, diagnostics: { ...valid.scroll.diagnostics, back: 100 } } },
  ])
    assert.throws(() => validate({ ...valid, ...change }), /Invalid performance measurement/);
  for (const key of ['scrollHeight', 'clientHeight', 'start', 'bottom', 'back']) {
    const diagnostics = { ...valid.scroll.diagnostics };
    delete diagnostics[key];
    assert.throws(
      () => validate({ ...valid, scroll: { ...valid.scroll, diagnostics } }),
      /Invalid performance measurement/,
    );
  }
});

test('performance sampling control fixes warmups, measured blocks and idle pauses', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const schedule = new Function(
    'test',
    script + '\nreturn typeof performanceSchedule === "function" ? performanceSchedule : undefined;',
  )(register);
  assert.equal(typeof schedule, 'function', 'Missing finite sampling schedule');
  assert.deepEqual(schedule('report'), [{ index: 0, warmup: false, block: 0, pauseBeforeMs: 0 }]);
  const baseline = schedule('calibrate');
  assert.equal(baseline.length, 33);
  assert.deepEqual(
    baseline.filter((sample) => sample.warmup).map((sample) => sample.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    baseline.filter((sample) => sample.pauseBeforeMs).map((sample) => [sample.index, sample.pauseBeforeMs]),
    [
      [13, 60000],
      [23, 60000],
    ],
  );
  for (const block of [0, 1, 2])
    assert.equal(baseline.filter((sample) => !sample.warmup && sample.block === block).length, 10);
  const validation = schedule('validate');
  assert.equal(validation.length, 6);
  assert.equal(validation.filter((sample) => sample.warmup).length, 3);
  assert.equal(validation.filter((sample) => !sample.warmup).length, 3);
  assert.ok(validation.every((sample) => sample.pauseBeforeMs === 0));
  assert.throws(() => schedule('unknown'), /Invalid performance mode/);
});

test('performance sampling control prepares once and retains earlier thumbnail receipts on failure', async () => {
  for (const thumbnailFailure of [false, true]) {
    let inspected = 0;
    let hook;
    let measure;
    let time = 0;
    let uploads = 0;
    let resets = 0;
    let created = 0;
    let closed = 0;
    const attachments = [];
    const pauses = [];
    const info = {
      annotations: [],
      outputPath: () => 'fixture-dataset-progress.ndjson',
      attach: async (name, options) => attachments.push({ name, body: JSON.parse(options.body) }),
    };
    const register = Object.assign(
      (name, callback) => {
        if (name.startsWith('records startup')) measure = callback;
      },
      {
        describe: (_name, run) => run(),
        beforeAll: (callback) => (hook = callback),
        setTimeout: () => {},
        info: () => info,
      },
    );
    const context = () => {
      let evaluations = 0;
      return {
        close: async () => {
          closed++;
        },
        newPage: async () => ({
          goto: async () => {
            time += 20;
          },
          locator: () => ({
            first: () => ({
              waitFor: async () => {
                time++;
              },
            }),
          }),
          evaluate: async (_callback, args) => {
            if (args?.assetId && thumbnailFailure && ++inspected === 3) throw new Error('thumbnail control failure');
            return args?.assetId
              ? {
                  assetId: args.assetId,
                  width: 32,
                  height: 32,
                  bytes: 1024,
                  contentType: 'image/jpeg',
                  sha256: 'a'.repeat(64),
                }
              : ++evaluations % 2 === 1
                ? { domContentLoadedMs: 12, loadMs: 20 }
                : {
                    frames: 59,
                    longFrames: 0,
                    medianFrameMs: 17,
                    worstFrameMs: 20,
                    diagnostics: { scrollHeight: 600, clientHeight: 100, start: 0, bottom: 500, back: 0 },
                  };
          },
        }),
      };
    };
    const browser = {
      version: () => '151.0.7922.34',
      newContext: async () => {
        created++;
        return context();
      },
    };
    class Clock extends Date {
      static now() {
        return time;
      }
    }
    const utils = {
      initSdk: () => {},
      resetDatabase: async () => {
        resets++;
      },
      adminSetup: async () => ({ accessToken: 'fixture-token' }),
      createAsset: async () => ({ id: `fixture-asset-${++uploads}`, status: 'created' }),
      waitForQueueFinish: async () => {},
      setAuthCookies: async () => {},
    };
    const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
    let generated = 0;
    new Function(
      'test',
      'utils',
      'expect',
      'Date',
      'createHash',
      'makeRandomImage',
      'process',
      'lstatSync',
      'readFileSync',
      'setTimeout',
      'clearTimeout',
      'defaults',
      'writeFileSync',
      'appendFileSync',
      script,
    )(
      register,
      utils,
      (value) => ({ toBeGreaterThan: (minimum) => assert.ok(value > minimum) }),
      Clock,
      createHash,
      () => Buffer.from(`calibration-control-${++generated}`),
      {
        version: 'v24.21.0',
        env: {
          FL139_PERFORMANCE_MODE: 'calibrate',
          FL139_PERFORMANCE_IDENTITY: 'fixture-identity',
          FL139_PERFORMANCE_OBSERVED: 'fixture-observed',
        },
      },
      () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
      (path) =>
        JSON.stringify(
          path === 'fixture-observed'
            ? { observedAt: time, environment: referenceEnvironment }
            : {
                protocol: 'fl139-library32-cold-context-warm-stack-v1',
                admitted: true,
                environment: referenceEnvironment,
                environmentSha256: createHash('sha256')
                  .update(JSON.stringify(Object.entries(referenceEnvironment).sort(([a], [b]) => a.localeCompare(b))))
                  .digest('hex'),
                application: {
                  imageSha256: 'e'.repeat(64),
                  sourceCommit: 'f'.repeat(40),
                  webManifestSha256: 'a'.repeat(64),
                  webIdentity: 'control-only',
                },
              },
        ),
      (callback, delay) => {
        if (delay === 60000) {
          pauses.push(delay);
          queueMicrotask(callback);
        }
        return 1;
      },
      () => {},
      {},
      () => {},
      () => {},
    );
    if (thumbnailFailure) {
      await assert.rejects(hook({ browser }), /thumbnail control failure/);
      const dataset = attachments.find((entry) => entry.name === 'performance-dataset.json').body;
      assert.equal(dataset.complete, false);
      assert.equal(dataset.assets.length, 200);
      assert.equal(dataset.thumbnails.length, 2);
      assert.equal(created, 1);
      assert.equal(closed, 1);
      continue;
    }
    await hook({ browser });
    const legacy = context();
    await measure({ browser, baseURL: 'http://127.0.0.1:2285', context: legacy, page: await legacy.newPage() });
    const samples = attachments.filter((entry) => entry.name.startsWith('performance-sample-'));
    assert.equal(samples.length, 33);
    assert.equal(samples.filter((entry) => entry.body.warmup).length, 3);
    assert.equal(samples.filter((entry) => !entry.body.warmup).length, 30);
    assert.equal(created, 34);
    assert.equal(closed, 34);
    const dataset = attachments.find((entry) => entry.name === 'performance-dataset.json').body;
    assert.equal(dataset.thumbnails.length, 200);
    assert.match(dataset.datasetSha256, /^[a-f0-9]{64}$/);
    assert.equal(uploads, 200);
    assert.equal(resets, 1);
    assert.deepEqual(pauses, [60000, 60000]);
  }
});

test('reference comparator control accepts equality and reports each ceiling exceeded', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const compare = new Function(
    'test',
    script + '\nreturn typeof compareMeasurements === "function" ? compareMeasurements : undefined;',
  )(register);
  assert.equal(typeof compare, 'function', 'Missing reference comparator');
  const report = {
    libraryItems: 200,
    startup: { domContentLoadedMs: 12, loadMs: 20 },
    firstThumbnailMs: 21,
    scroll: {
      frames: 59,
      longFrames: 0,
      medianFrameMs: 17,
      worstFrameMs: 20,
      diagnostics: { scrollHeight: 600, clientHeight: 100, start: 0, bottom: 500, back: 0 },
    },
  };
  const limits = {
    'startup.domContentLoadedMs': 12,
    'startup.loadMs': 20,
    firstThumbnailMs: 21,
    'scroll.longFrames': 0,
    'scroll.medianFrameMs': 17,
    'scroll.worstFrameMs': 20,
  };
  const profile = {
    schema: 1,
    protocol: 'fl139-library32-cold-context-warm-stack-v1',
    approved: true,
    environmentSha256: 'a'.repeat(64),
    limits,
  };
  assert.deepEqual(compare(report, profile), []);
  for (const field of Object.keys(limits)) {
    const candidate = structuredClone(report);
    const keys = field.split('.');
    (keys.length === 1 ? candidate : candidate[keys[0]])[keys.at(-1)]++;
    assert.deepEqual(compare(candidate, profile), [field]);
  }
  for (const change of [
    { approved: false },
    { schema: 2 },
    { protocol: 'old' },
    { environmentSha256: '' },
    { limits: {} },
    { limits: { ...limits, firstThumbnailMs: -1 } },
  ]) {
    assert.throws(() => compare(report, { ...profile, ...change }), /Invalid performance profile/);
  }
});

test('performance sampling control closes a context created after the iteration deadline', async () => {
  let measure;
  let closed = 0;
  const pending = Promise.withResolvers();
  const info = { annotations: [], attach: async () => {} };
  const register = Object.assign(
    (name, callback) => {
      if (name.startsWith('records startup')) measure = callback;
    },
    {
      describe: (_name, run) => run(),
      beforeAll: () => {},
      setTimeout: () => {},
      info: () => info,
    },
  );
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  new Function('test', 'process', 'setTimeout', 'clearTimeout', script)(
    register,
    { env: {} },
    (callback) => {
      callback();
      return 1;
    },
    () => {},
  );
  await assert.rejects(
    measure({ browser: { newContext: () => pending.promise }, baseURL: 'http://127.0.0.1:2285' }),
    /Performance iteration deadline/,
  );
  pending.resolve({
    close: async () => {
      closed++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1, 'Late context must close even after the outer finally has finished');
});

test('reference admission control rejects a bare flag, missing provenance and environment drift', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const validate = new Function(
    'test',
    'createHash',
    script + '\nreturn typeof validateReferenceIdentity === "function" ? validateReferenceIdentity : undefined;',
  )(register, createHash);
  assert.equal(typeof validate, 'function', 'Missing reference admission validation');
  const observed = referenceEnvironment;
  const environmentSha256 = createHash('sha256')
    .update(JSON.stringify(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const identity = {
    protocol: 'fl139-library32-cold-context-warm-stack-v1',
    admitted: true,
    environment: observed,
    environmentSha256,
    application: {
      imageSha256: 'e'.repeat(64),
      sourceCommit: 'f'.repeat(40),
      webManifestSha256: 'a'.repeat(64),
      webIdentity: 'web75e-sdk75e-adapter-cdd544ab34a7',
    },
  };
  assert.doesNotThrow(() => validate(identity, observed));
  assert.throws(() => validate({ admitted: true }, observed), /Invalid reference identity/);
  for (const field of Object.keys(observed)) {
    const environment = { ...observed };
    delete environment[field];
    assert.throws(() => validate({ ...identity, environment }, observed), /Invalid reference identity/);
    assert.throws(() => validate(identity, { ...observed, [field]: 'drift' }), /Reference environment mismatch/);
  }
  for (const change of [{ application: {} }, { environmentSha256: '0'.repeat(64) }, { admitted: false }]) {
    assert.throws(() => validate({ ...identity, ...change }, observed), /Invalid reference identity/);
  }
  for (const value of [-1, NaN, Infinity, 'not-memory']) {
    const environment = { ...observed, memoryBytes: value };
    const environmentSha256 = createHash('sha256')
      .update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    assert.throws(
      () => validate({ ...identity, environment, environmentSha256 }, environment),
      /Invalid reference identity/,
    );
  }
});

test('reference admission control refuses stale or incomplete evidence before SDK initialization', async () => {
  const environmentSha256 = createHash('sha256')
    .update(JSON.stringify(Object.entries(referenceEnvironment).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const valid = {
    protocol: 'fl139-library32-cold-context-warm-stack-v1',
    admitted: true,
    environment: referenceEnvironment,
    environmentSha256,
    application: {
      imageSha256: 'e'.repeat(64),
      sourceCommit: 'f'.repeat(40),
      webManifestSha256: 'a'.repeat(64),
      webIdentity: 'control-only',
    },
  };
  for (const scenario of ['bare-flag', 'stale', 'node-drift', 'browser-drift']) {
    let hook;
    let initialized = false;
    const register = Object.assign(() => {}, {
      describe: (_name, run) => run(),
      beforeAll: (callback) => (hook = callback),
      setTimeout: () => {},
    });
    const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
    new Function('test', 'utils', 'process', 'Date', 'lstatSync', 'readFileSync', 'createHash', script)(
      register,
      {
        initSdk: () => {
          initialized = true;
        },
      },
      {
        version: scenario === 'node-drift' ? 'v25.0.0' : 'v24.21.0',
        env: {
          FL139_PERFORMANCE_MODE: 'calibrate',
          FL139_PERFORMANCE_IDENTITY: 'identity',
          FL139_PERFORMANCE_OBSERVED: 'observed',
        },
      },
      { now: () => 0 },
      () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
      (path) =>
        JSON.stringify(
          path === 'observed'
            ? { observedAt: scenario === 'stale' ? -60000 : 0, environment: referenceEnvironment }
            : scenario === 'bare-flag'
              ? { admitted: true }
              : valid,
        ),
      createHash,
    );
    await assert.rejects(
      hook({ browser: { version: () => (scenario === 'browser-drift' ? 'other-browser' : '151.0.7922.34') } }),
      /Invalid reference identity|Stale reference observations|Reference environment mismatch/,
    );
    assert.equal(initialized, false, scenario);
  }
});

test('prepared thumbnail control requires every asset, decoded dimensions and content evidence', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const validate = new Function(
    'test',
    script + '\nreturn typeof validatePreparedThumbnails === "function" ? validatePreparedThumbnails : undefined;',
  )(register);
  assert.equal(typeof validate, 'function', 'Missing prepared thumbnail validation');
  const ids = Array.from({ length: 200 }, (_, index) => `fixture-asset-${index + 1}`);
  const thumbnails = ids.map((assetId) => ({
    assetId,
    width: 32,
    height: 32,
    bytes: 1024,
    contentType: 'image/jpeg',
    sha256: 'a'.repeat(64),
  }));
  assert.doesNotThrow(() => validate(thumbnails, ids));
  assert.throws(() => validate(thumbnails.slice(1), ids), /Invalid prepared thumbnails/);
  for (const change of [
    { assetId: 'other' },
    { width: 0 },
    { height: NaN },
    { bytes: 0 },
    { contentType: 'text/html' },
    { sha256: '' },
  ]) {
    const candidate = structuredClone(thumbnails);
    candidate[0] = { ...candidate[0], ...change };
    assert.throws(() => validate(candidate, ids), /Invalid prepared thumbnails/);
  }
});

test('reference admission binds matching metadata to the actual context protocol', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const validate = new Function('test', 'createHash', script + '\nreturn validateReferenceIdentity;')(
    register,
    createHash,
  );
  for (const [key, value] of Object.entries({
    viewportWidth: 1920,
    viewportHeight: 1080,
    deviceScaleFactor: 2,
    locale: 'fr-FR',
    timezone: 'America/Edmonton',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    cachePolicy: 'warm-context',
  })) {
    const environment = { ...referenceEnvironment, [key]: value };
    const identity = {
      protocol: 'fl139-library32-cold-context-warm-stack-v1',
      admitted: true,
      environment,
      environmentSha256: createHash('sha256')
        .update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex'),
      application: {
        imageSha256: 'e'.repeat(64),
        sourceCommit: 'f'.repeat(40),
        webManifestSha256: 'a'.repeat(64),
        webIdentity: 'control',
      },
    };
    assert.throws(() => validate(identity, environment), /Reference context mismatch/, key);
  }
});

test('thumbnail evidence cancels an oversized streamed body before decoding', async () => {
  const start = source.indexOf('async ({ assetId, deadline }) =>');
  const boundary = /\n\s*\{ assetId, deadline \},/.exec(source.slice(start));
  const end = boundary ? start + boundary.index : -1;
  assert.ok(start >= 0 && end > start, 'Missing per-asset streamed thumbnail evidence');
  const callback = stripTypeScriptTypes('const inspect = ' + source.slice(start, end).trim().replace(/,$/, '') + ';');
  let reads = 0;
  let cancelled = false;
  let decoded = false;
  const inspect = new Function('fetch', 'createImageBitmap', 'crypto', callback + '\nreturn inspect;')(
    async () => ({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(700000 + ++reads) }),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    }),
    async () => {
      decoded = true;
    },
    {},
    () => {},
    () => {},
  );
  await assert.rejects(inspect({ assetId: 'control', deadline: Date.now() + 1000 }), /Thumbnail evidence size/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(decoded, false);
});

test('validation profile requires baseline provenance, thirty samples and Root approval binding', () => {
  const register = Object.assign(() => {}, { describe: (_name, run) => run(), beforeAll: () => {} });
  const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
  const validate = new Function(
    'test',
    script + '\nreturn typeof validateProfileAdmission === "function" ? validateProfileAdmission : undefined;',
  )(register);
  assert.equal(typeof validate, 'function', 'Missing baseline evidence admission');
  const profile = {
    schema: 1,
    protocol: 'fl139-library32-cold-context-warm-stack-v1',
    approved: true,
    environmentSha256: 'a'.repeat(64),
    datasetSha256: 'b'.repeat(64),
    limits: {
      'startup.domContentLoadedMs': 12,
      'startup.loadMs': 20,
      firstThumbnailMs: 21,
      'scroll.longFrames': 0,
      'scroll.medianFrameMs': 17,
      'scroll.worstFrameMs': 20,
    },
    baselineApplication: {
      sourceCommit: 'c'.repeat(40),
      imageSha256: 'd'.repeat(64),
      webManifestSha256: 'e'.repeat(64),
      webIdentity: 'control-only',
    },
    sampleSha256: Array.from({ length: 30 }, (_, i) => createHash('sha256').update(`control-${i}`).digest('hex')),
    measuredAt: '2026-10-12T12:00:00.000Z',
    rootApprovalReceiptSha256: 'f'.repeat(64),
  };
  assert.doesNotThrow(() => validate(profile));
  for (const key of [
    'baselineApplication',
    'sampleSha256',
    'measuredAt',
    'rootApprovalReceiptSha256',
    'datasetSha256',
  ]) {
    const candidate = { ...profile };
    delete candidate[key];
    assert.throws(() => validate(candidate), /Invalid baseline evidence/, key);
  }
  for (const change of [
    { sampleSha256: profile.sampleSha256.slice(1) },
    { sampleSha256: Array(30).fill('a'.repeat(64)) },
    { baselineApplication: {} },
    { measuredAt: 'not-date' },
    { rootApprovalReceiptSha256: 'flag' },
  ])
    assert.throws(() => validate({ ...profile, ...change }), /Invalid baseline evidence/);
});

test('200-image preparation stops uploads at the shared deadline and passes cancellation', async () => {
  const fixture = setupPerformanceFixture(source, 5000, true, true, 600000);
  await assert.rejects(fixture.run(), /Preparation deadline/);
  const result = fixture.result();
  assert.equal(result.uploads, 1);
  assert.equal(result.queues.length, 0);
  assert.equal(result.uploaded[0].options.timeout, 600000);
  assert.ok(result.uploaded[0].options.signal instanceof AbortSignal);
  assert.equal(result.attachments.find((entry) => entry.name === 'performance-dataset.json').body.complete, false);
});

test('preparation retains each acknowledged asset before a hook timeout can discard attachments', async () => {
  const fixture = setupPerformanceFixture(source, 250000);
  await assert.rejects(fixture.run(), /queue deadline/);
  const progress = fixture.result().progressWrites;
  assert.equal(progress.filter((row) => row.kind === 'asset').length, 200);
  assert.equal(progress[0].kind, 'dataset');
  assert.equal(progress[0].fileDate, '2026-10-01T00:00:00.000Z');
  for (const [index, row] of progress.filter((row) => row.kind === 'asset').entries()) {
    assert.equal(row.assetId, `fixture-asset-${index + 1}`);
    assert.equal(
      row.sourceSha256,
      createHash('sha256')
        .update(`fixture-png-${index + 1}`)
        .digest('hex'),
    );
  }
  assert.equal(progress.at(-1).kind, 'status');
  assert.equal(progress.at(-1).complete, false);
});

test('preparation refuses an existing checkpoint without appending to it and restores SDK cancellation', async () => {
  const fixture = setupPerformanceFixture(source, 5000, true, true, 50, true);
  await assert.rejects(fixture.run(), /progress file exists/);
  assert.equal(fixture.result().progressWrites.length, 0);
  assert.equal(fixture.result().sdkDefaults.signal, undefined);
});

test('performance sampling failure stops after cleanup and retains both failure phases', async () => {
  for (const cleanupFails of [false, true]) {
    let measure;
    let created = 0;
    let closed = 0;
    const attachments = [];
    const measurementError = new Error('measurement refused');
    const cleanupError = new Error('cleanup refused');
    const register = Object.assign(
      (name, callback) => {
        if (name.startsWith('records startup')) measure = callback;
      },
      {
        describe: (_name, run) => run(),
        beforeAll: () => {},
        setTimeout: () => {},
        info: () => ({ attach: async (name, options) => attachments.push({ name, body: JSON.parse(options.body) }) }),
      },
    );
    const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''));
    new Function('test', 'process', 'setTimeout', 'clearTimeout', script)(
      register,
      { env: { FL139_PERFORMANCE_MODE: 'validate' } },
      () => 1,
      () => {},
    );
    await assert.rejects(
      measure({
        browser: {
          newContext: async () => {
            created++;
            return {
              newPage: async () => {
                throw measurementError;
              },
              close: async () => {
                closed++;
                if (cleanupFails) throw cleanupError;
              },
            };
          },
        },
        baseURL: 'http://127.0.0.1:2285',
      }),
      (error) => error === (cleanupFails ? cleanupError : measurementError),
    );
    assert.equal(created, 1);
    assert.equal(closed, 1);
    const report = attachments.find(({ name }) => name === 'performance-report.json').body;
    assert.equal(report.complete, false);
    assert.deepEqual(
      report.failures.map(({ phase }) => phase),
      cleanupFails ? ['measurement', 'context-cleanup'] : ['measurement'],
    );
  }
});
