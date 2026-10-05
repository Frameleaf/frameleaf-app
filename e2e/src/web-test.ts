import { test as base, type TestInfo } from '@playwright/test';
import { utils } from 'src/utils.js';

/** Playwright owns test cancellation; abort and drain the requests before the fixture tears down. */
export const test = base.extend<{
  assetReady: { signal: AbortSignal; onCleanup: (cleanup: () => Promise<void>) => void };
}>({
  assetReady: [
    // Playwright requires an object-destructured first parameter when discovering fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const controller = new AbortController();
      const cleanups: (() => Promise<void>)[] = [];
      try {
        await use({ signal: controller.signal, onCleanup: (cleanup) => cleanups.push(cleanup) });
      } finally {
        controller.abort();
        const results = await Promise.allSettled([
          utils.settlePendingWaits(controller.signal),
          ...cleanups.map((cleanup) => cleanup()),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') {
          throw failed.reason;
        }
      }
    },
    { auto: true },
  ],
});

/** beforeAll cannot use a test-scoped fixture, so its existing hook deadline owns this signal. */
export const withAssetReadySetup = (setup: (signal: AbortSignal) => Promise<void>) =>
  // eslint-disable-next-line no-empty-pattern
  async ({}, testInfo: TestInfo) => {
    const controller = new AbortController();
    const timer =
      testInfo.timeout > 0
        ? setTimeout(() => controller.abort(new Error('Asset setup exceeded its hook deadline')), testInfo.timeout)
        : undefined;
    try {
      await setup(controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await utils.settlePendingWaits(controller.signal);
    }
  };
