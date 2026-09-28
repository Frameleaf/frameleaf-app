import { isHttpError, lockAuthSession } from '@immich/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
import { isAssetViewerRoute, navigate } from '$lib/utils/navigation';
import { clearSessionMedia, revokeSessionView } from '$lib/utils/session-privacy';
import {
  closeSessionModals,
  markSessionLockSucceeded,
  releaseSessionLock,
  sessionAccess,
  setSessionLockPending,
  waitForSessionLockRefreshes,
  waitForSessionUnlocks,
} from './session-access.svelte';

let lockFlight: Promise<void> | undefined;

/**
 * The server's explicit Wrong PIN rejection (HTTP 400), which precedes any session change: the only
 * unlock failure that needs no compensating lock.
 */
export const isWrongPinError = (error: unknown) =>
  isHttpError(error) && error.status === 400 && getServerErrorMessage(error) === 'Wrong PIN code';

const isSensitiveRoute = (pathname: string) => {
  const roots = [Route.locked(), Route.suppressed()];
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
};

/** One lock flight for the root shield and TopBar, including PIN-prompt routes without a TopBar. */
export const requestSessionLock = (): Promise<void> => {
  if (lockFlight) {
    return lockFlight;
  }

  setSessionLockPending(true);
  sessionAccess.isElevated = false;
  sessionAccess.lockStatus = 'locking';
  const mediaCleared = clearSessionMedia();
  assetCacheManager.revoke();
  lockFlight = (async () => {
    try {
      // A stale PIN unlock can finish after its prompt unmounts. Lock only after it settles.
      await waitForSessionUnlocks();
      await lockAuthSession({ signal: AbortSignal.timeout(15_000) });
      markSessionLockSucceeded();
      await closeSessionModals();
      const pathname = page.url.pathname;
      if (isSensitiveRoute(pathname)) {
        await goto(Route.photos(), { replaceState: true, invalidateAll: true });
      } else if (isAssetViewerRoute(page)) {
        await navigate({ targetRoute: 'current', assetId: null }, { replaceState: true, invalidateAll: true });
      } else {
        await invalidateAll();
      }
      eventManager.emit('SessionLocked');
      eventManager.emit('SessionAccessChanged', { isElevated: false });
      await waitForSessionLockRefreshes();
      await mediaCleared;
      await releaseSessionLock();
      sessionAccess.lockStatus = 'idle';
      if (pathname !== Route.pinPrompt()) {
        // Mounted views have independent caches and requests; retain PR131's whole-document boundary.
        revokeSessionView(Route.photos());
      }
    } catch (error) {
      if (isHttpError(error) && error.status === 401) {
        // The authentication itself is gone, so nothing is left to lock: a retry would fail the
        // same way forever. Drop the barrier so it cannot outlive this session, and sign out.
        setSessionLockPending(false);
        sessionAccess.lockStatus = 'idle';
        revokeSessionView(Route.logout());
        return;
      }
      // The shield stays up and says so itself: toasts are hidden underneath it.
      sessionAccess.lockStatus = 'failed';
      handleError(error, get(t)('errors.something_went_wrong'));
    } finally {
      lockFlight = undefined;
    }
  })();
  return lockFlight;
};

/**
 * A pending lock belongs to the session that started it; a new sign-in or a sign-out ends it, so the
 * flag can never carry into the next session. The root layout installs this once.
 */
export const watchSessionLockOwner = () => {
  const dropPendingLock = () => {
    if (lockFlight) {
      return;
    }
    setSessionLockPending(false);
    sessionAccess.lockStatus = 'idle';
  };
  return eventManager.on({ AuthLogin: dropPendingLock, AuthLogout: dropPendingLock });
};
