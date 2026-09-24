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

export type SessionLockStatus = 'idle' | 'locking' | 'failed';

export const sessionAccess = $state({
  isElevated: false,
  lockPending: pending,
  /** What the root shield says about the pending lock: toasts are hidden under it. */
  lockStatus: 'idle' as SessionLockStatus,
  /**
   * FL-83: this tab is hidden while elevated. Only this tab's content is concealed; the server
   * session stays unlocked for other tabs until an explicit lock or its idle timeout.
   */
  concealed: false,
  revision: 0,
  retryLock: undefined as (() => Promise<void>) | undefined,
});

/** Unlock requests are bounded so a stalled one cannot hold a pending lock forever. */
export const SESSION_UNLOCK_TIMEOUT_MS = 15_000;

export const setSessionLockPending = (value: boolean) => {
  if (value && !sessionAccess.lockPending) {
    sessionAccess.revision++;
  }
  sessionAccess.lockPending = value;
  if (!value) {
    dismissNewModals = false;
  }
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
  dismissNewModals = true;
};

const refreshes = new Set<Promise<unknown>>();
const pendingUnlocks = new Set<Promise<unknown>>();
const activeModals = new Set<() => Promise<void>>();
const trackedManagers = new WeakSet<object>();
let dismissNewModals = false;

/** All @immich/ui show/showDialog calls pass through open; track them once, before viewer actions can run. */
export const trackSessionModals = (manager: typeof import('@immich/ui').modalManager) => {
  if (trackedManagers.has(manager)) {
    return;
  }
  trackedManagers.add(manager);
  const originalOpen = manager.open;
  manager.open = ((...args: unknown[]) => {
    const modal = Reflect.apply(originalOpen, manager, args) as {
      onClose: Promise<unknown>;
      close: () => Promise<void>;
    };
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= modal
        .close()
        .then(() => {
          activeModals.delete(close);
        })
        .catch((error: unknown) => {
          // a failed close must be retried by the next sweep, not replay the same rejection
          closing = undefined;
          throw error;
        });
      return closing;
    };
    activeModals.add(close);
    void modal.onClose.then(() => activeModals.delete(close)).catch(() => activeModals.delete(close));
    if (dismissNewModals) {
      void close().catch(() => {});
    }
    return modal;
  }) as typeof manager.open;
};

/** Unmount every manager portal, including dialogs created while lock refreshes are pending. */
export const closeSessionModals = async () => {
  while (activeModals.size > 0) {
    await Promise.all([...activeModals].map((close) => close()));
  }
};

/** Release the shield in the same turn as the final modal/native-dialog sweep. */
export const releaseSessionLock = async () => {
  do {
    await closeSessionModals();
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]:not(.session-lock-shield)')) {
      dialog.close();
    }
  } while (activeModals.size > 0);
  setSessionLockPending(false);
};

/** Register PIN unlock work before awaiting it, so a concurrent lock cannot finish first. */
export const trackSessionUnlock = <T>(unlock: Promise<T>): Promise<T> => {
  pendingUnlocks.add(unlock);
  void unlock.finally(() => pendingUnlocks.delete(unlock)).catch(() => {});
  return unlock;
};

export const hasPendingSessionUnlocks = () => pendingUnlocks.size > 0;

export const waitForSessionUnlocks = async () => {
  while (pendingUnlocks.size > 0) {
    await Promise.allSettled(pendingUnlocks);
  }
};

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
