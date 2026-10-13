import { on } from 'svelte/events';
import { browser } from '$app/env';

const isSupported = browser && 'wakeLock' in navigator;

let sentinel: WakeLockSentinel | undefined;
let acquiring = false;
/**
 * Who currently wants the screen kept on (uploads, a playing slideshow). The lock is held
 * while anyone does, so one holder finishing never switches the screen off under another.
 */
const holders = new Set<string>();

export async function acquireWakeLock(holder = 'default') {
  holders.add(holder);
  if (!isSupported) {
    return;
  }
  if (sentinel && !sentinel.released) {
    return;
  }
  if (acquiring) {
    return;
  }
  acquiring = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (holders.size === 0) {
      // everyone let go while the request was in flight
      await lock.release().catch((error: unknown) => console.warn('Failed to release wake lock:', error));
    } else {
      sentinel = lock;
    }
  } catch (error) {
    console.warn('Failed to acquire wake lock:', error);
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
  // Unset first to avoid race condition after await
  sentinel = undefined;

  try {
    await toReleaseSentinel.release();
  } catch (error) {
    // an already released lock (the tab was hidden) can reject; nothing is left to undo
    console.warn('Failed to release wake lock:', error);
  }
}

if (isSupported) {
  // Wake lock is cleared when user changes to a different tab,
  // so we need to reacquire the wake lock when they come back.
  on(globalThis, 'visibilitychange', () => {
    if (holders.size > 0 && document.visibilityState === 'visible') {
      void acquireWakeLock([...holders][0]);
    }
  });
}
