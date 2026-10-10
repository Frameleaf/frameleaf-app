import { utils } from 'src/utils.js';

/** Vitest beforeAll has no test signal; the existing hook budget owns its requests and cleanup. */
export const withApiAssetReadiness = (timeout: number, setup: (signal: AbortSignal) => Promise<void>) => async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Asset setup exceeded its hook deadline')), timeout);
  try {
    await setup(controller.signal);
    controller.signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    controller.abort();
    await utils.settlePendingWaits(controller.signal);
  }
};
