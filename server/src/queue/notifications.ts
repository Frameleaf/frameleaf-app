import { performance } from 'node:perf_hooks';

export const QUEUE_CHANNEL = 'frameleaf_jobs';

/** One dedicated LISTEN session; failed initial connection retries on the existing bounded scan. */
export function queueNotifications(
  client: {
    listen: (channel: string, onMessage: () => void, onConnected: () => void) => Promise<unknown>;
    end: (options: { timeout: number }) => Promise<unknown>;
  },
  wake: () => void,
) {
  let subscribed = false;
  let pending = false;
  let closed = false;
  let nextConnect = 0;
  return {
    connect() {
      if (closed || subscribed || pending || performance.now() < nextConnect) return;
      pending = true;
      nextConnect = performance.now() + 30_000;
      // postgres.js reconnects a successful listener and re-LISTENs automatically.
      void client
        .listen(QUEUE_CHANNEL, wake, wake)
        .then(() => {
          subscribed = true;
        })
        .catch(() => {
          // The five-second durable scan still dispatches work while notifications are unavailable.
        })
        .finally(() => {
          pending = false;
        });
    },
    async close() {
      closed = true;
      await client.end({ timeout: 1 });
    },
  };
}
