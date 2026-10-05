import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventJournal, pollRequest, requestOnce, waitUntil, withDeadline } from './harness-wait.ts';

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
