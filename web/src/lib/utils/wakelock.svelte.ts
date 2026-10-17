import { on } from 'svelte/events';
import { browser } from '$app/env';

const isSupported = browser && 'wakeLock' in navigator;

let sentinel: WakeLockSentinel | undefined;
let acquiring = false;
let retryRequested = false;
// Holder names are idempotent: uploads and slideshows share one native lock.
const holders = new Set<string>();

async function releaseSentinel(lock: WakeLockSentinel) {
  try {
    await lock.release();
  } catch (error) {
    console.warn('Failed to release wake lock:', error);
  }
}

export async function acquireWakeLock(holder = 'default') {
  holders.add(holder);
  if (!isSupported) {
    return;
  }
  if (sentinel && !sentinel.released) {
    return;
  }
  if (acquiring) {
    retryRequested = true;
    return;
  }
  acquiring = true;
  try {
    do {
      retryRequested = false;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (holders.size === 0) {
          await releaseSentinel(lock);
        } else {
          sentinel = lock;
        }
      } catch (error) {
        console.warn('Failed to acquire wake lock:', error);
      }
      // Drain only newer intent; a refusal alone must not create a retry loop.
    } while (retryRequested && holders.size > 0 && (!sentinel || sentinel.released));
  } finally {
    acquiring = false;
  }
}

export async function releaseWakeLock(holder = 'default') {
  holders.delete(holder);
  if (holders.size > 0 || !sentinel) {
    return;
  }

  const toReleaseSentinel = sentinel;
  // A late release must not clear a newer acquisition.
  sentinel = undefined;
  await releaseSentinel(toReleaseSentinel);
}

if (isSupported) {
  on(globalThis, 'visibilitychange', () => {
    if (holders.size > 0 && document.visibilityState === 'visible') {
      void acquireWakeLock(holders.values().next().value);
    }
  });
}
