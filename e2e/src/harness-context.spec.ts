import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ownedWait, settlePendingWaits } from './harness-context';

let active = 0;
let reads = 0;
let timedOutSettled = false;
let finishedSettled = false;

it.fails('uses the actual runner timeout, even when the helper has a larger CI budget', { timeout: 30 }, async () => {
  await ownedWait('long CI queue wait', 60_000, async ({ signal }) => {
    active++;
    reads++;
    try {
      await sleep(60_000, undefined, { signal });
    } finally {
      active--;
      timedOutSettled = true;
    }
  });
});

it('starts the next test only after the expired test request has settled', () => {
  expect(timedOutSettled).toBe(true);
  expect(active).toBe(0);
  expect(reads).toBe(1);
});

it('owns an accidentally unawaited helper until its test-finished cleanup', async () => {
  const started = Promise.withResolvers<void>();
  void ownedWait('leftover queue read', 60_000, async ({ signal }) => {
    active++;
    started.resolve();
    try {
      await sleep(60_000, undefined, { signal });
    } finally {
      active--;
      finishedSettled = true;
    }
  }).catch(() => {});
  await started.promise;
});

it('does not carry the unawaited request into the next test', () => {
  expect(finishedSettled).toBe(true);
  expect(active).toBe(0);
});

it('lets a caller abort and await exactly the requests it owns', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let settled = false;
  const pending = ownedWait('caller queue read', 60_000, async ({ signal }) => {
    started.resolve();
    try {
      await sleep(60_000, undefined, { signal });
    } finally {
      settled = true;
    }
  }, controller.signal);
  const rejected = expect(pending).rejects.toThrow('caller ended');
  await started.promise;
  controller.abort(new Error('caller ended'));
  await settlePendingWaits(controller.signal);
  expect(settled).toBe(true);
  await rejected;
});

let retryAttempt = 0;
it('gives a normal assertion retry a fresh scope after the prior attempt settles', { retry: 1 }, async () => {
  retryAttempt++;
  await expect(ownedWait('retry queue read', 100, async () => 'complete')).resolves.toBe('complete');
  expect(retryAttempt).toBe(2);
});
