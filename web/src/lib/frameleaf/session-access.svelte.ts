import { AssetVisibility } from '@immich/sdk';
import { browser } from '$app/environment';

/**
 * Whether this browser session is unlocked with the PIN (FL-34), for code outside the top bar that
 * needs to know: an unlocked session's timeline reveals the owner's own sensitive marks and
 * detections, so marking something there keeps it in view instead of removing it. The top bar,
 * which asks the server and hears every lock and unlock, keeps it current.
 */
const pendingKey = 'frameleaf:session-lock-pending';
let pending = false;
try {
  pending = browser && sessionStorage.getItem(pendingKey) === 'true';
} catch {
  // Storage may be disabled; the in-memory barrier still protects this tab.
}

export const sessionAccess = $state({
  isElevated: false,
  lockPending: pending,
  revision: 0,
  retryLock: undefined as (() => Promise<void>) | undefined,
});

export const setSessionLockPending = (value: boolean) => {
  if (value && !sessionAccess.lockPending) {
    sessionAccess.revision++;
  }
  sessionAccess.lockPending = value;
  try {
    if (value) {
      sessionStorage.setItem(pendingKey, 'true');
    } else {
      sessionStorage.removeItem(pendingKey);
    }
  } catch {
    // Keep the in-memory barrier when browser storage is unavailable.
  }
};

/** Invalidate responses started before the server confirmed the lock. */
export const markSessionLockSucceeded = () => {
  sessionAccess.revision++;
};

const refreshes = new Set<Promise<unknown>>();

/** Keep the root shield up while mounted media views replace their cached elevated results. */
export const trackSessionLockRefresh = <T>(refresh: Promise<T>): Promise<T> => {
  if (sessionAccess.lockPending) {
    refreshes.add(refresh);
    void refresh.finally(() => refreshes.delete(refresh)).catch(() => {});
  }
  return refresh;
};

export const waitForSessionLockRefreshes = async () => {
  while (refreshes.size > 0) {
    await Promise.allSettled(refreshes);
  }
};

/**
 * True when a view with these options reveals the owner's marked and detected items to an unlocked
 * session: the main timeline, as the server decides it (`TimelineService.getRevealOptions`).
 */
export const revealsLocks = (
  options: { visibility?: AssetVisibility; albumId?: string },
  isElevated = sessionAccess.isElevated,
): boolean => isElevated && options.visibility === AssetVisibility.Timeline && !options.albumId;
