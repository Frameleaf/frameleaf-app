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
      let primary: unknown;
      let failed = false;
      try {
        await use({
          signal: controller.signal,
          onCleanup: (cleanup) => {
            cleanups.push(cleanup);
          },
        });
      } catch (error) {
        primary = error;
        failed = true;
      }
      controller.abort();
      const results = await Promise.allSettled([
        utils.settlePendingWaits(controller.signal),
        ...cleanups.map(async (cleanup) => cleanup()),
      ]);
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (errors.length > 0) {
        if (failed) {
          throw new AggregateError([primary, ...errors], 'Browser test and owned cleanup failed', { cause: primary });
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        throw new AggregateError(errors, 'Browser owned cleanup failed', { cause: errors[0] });
      }
      if (failed) {
        throw primary;
      }
    },
    { auto: true },
  ],
});

/** beforeAll cannot use a test-scoped fixture, so its existing hook deadline owns this signal. */
export const withAssetReadySetup =
  (setup: (signal: AbortSignal) => Promise<void>) =>
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
