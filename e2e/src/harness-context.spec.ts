import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ownedWait, settlePendingWaits } from './harness-context';

const state = { active: 0, reads: 0, timedOutSettled: false, finishedSettled: false, retryAttempt: 0 };

it.fails('uses the actual runner timeout, even when the helper has a larger CI budget', { timeout: 30 }, async () => {
  await ownedWait('long CI queue wait', 60_000, async ({ signal }) => {
    state.active++;
    state.reads++;
    try {
      await sleep(60_000, undefined, { signal });
    } finally {
      state.active--;
      state.timedOutSettled = true;
    }
  });
});

it('starts the next test only after the expired test request has settled', () => {
  expect(state.timedOutSettled).toBe(true);
  expect(state.active).toBe(0);
  expect(state.reads).toBe(1);
});

it('owns an accidentally unawaited helper until its test-finished cleanup', async () => {
  const started = Promise.withResolvers<void>();
  void ownedWait('leftover queue read', 60_000, async ({ signal }) => {
    state.active++;
    started.resolve();
    try {
      await sleep(60_000, undefined, { signal });
    } finally {
      state.active--;
      state.finishedSettled = true;
    }
  }).catch(() => {});
  await started.promise;
});

it('does not carry the unawaited request into the next test', () => {
  expect(state.finishedSettled).toBe(true);
  expect(state.active).toBe(0);
});

it('joins implicit test-owned transports before test-finished cleanup', async ({ signal }) => {
  const release = Promise.withResolvers<void>();
  const pending = ownedWait('admitted test request', 1000, () => release.promise);
  let settled = false;
  const settlement = (async () => {
    await settlePendingWaits(signal);
    settled = true;
  })();
  try {
    await sleep(0);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    await pending;
    await settlement;
  }
  expect(settled).toBe(true);
});

it('lets a caller abort and await exactly the requests it owns', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let settled = false;
  const pending = ownedWait(
    'caller queue read',
    60_000,
    async ({ signal }) => {
      started.resolve();
      try {
        await sleep(60_000, undefined, { signal });
      } finally {
        settled = true;
      }
    },
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow('caller ended');
  await started.promise;
  controller.abort(new Error('caller ended'));
  await settlePendingWaits(controller.signal);
  expect(settled).toBe(true);
  await rejected;
});

it('gives a normal assertion retry a fresh scope after the prior attempt settles', { retry: 1 }, async () => {
  state.retryAttempt++;
  await expect(ownedWait('retry queue read', 100, async () => 'complete')).resolves.toBe('complete');
  expect(state.retryAttempt).toBe(2);
});
