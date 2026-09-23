import { lockAuthSession } from '@immich/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { handleError } from '$lib/utils/handle-error';
import { isAssetViewerRoute, navigate } from '$lib/utils/navigation';
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
  lockFlight = (async () => {
    try {
      // A stale PIN unlock can finish after its prompt unmounts. Lock only after it settles.
      await waitForSessionUnlocks();
      await lockAuthSession({ signal: AbortSignal.timeout(15_000) });
      markSessionLockSucceeded();
      await closeSessionModals();
      const pathname = page.url.pathname;
      if (isSensitiveRoute(pathname) || pathname === Route.pinPrompt()) {
        await goto(Route.photos(), { replaceState: true, invalidateAll: true });
      } else if (isAssetViewerRoute(page)) {
        await navigate({ targetRoute: 'current', assetId: null }, { replaceState: true, invalidateAll: true });
      } else {
        await invalidateAll();
      }
      eventManager.emit('SessionLocked');
      eventManager.emit('SessionAccessChanged', { isElevated: false });
      await waitForSessionLockRefreshes();
      await releaseSessionLock();
    } catch (error) {
      handleError(error, get(t)('errors.something_went_wrong'));
    } finally {
      lockFlight = undefined;
    }
  })();
  return lockFlight;
};
