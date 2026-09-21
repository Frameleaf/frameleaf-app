import { getAuthStatus } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { revokeSessionView } from '$lib/utils/session-privacy';

/** Event-driven revalidation; the expiry deadline never waits for a network response. */
export const watchSessionPrivacy = (isAuthenticated: () => boolean) => {
  let elevated = false;
  let stopped = false;
  let generation = 0;
  let deadline: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const revoke = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    generation++;
    clearTimeout(timer);
    revokeSessionView(Route.photos());
  };

  const refresh = async () => {
    if (stopped || !isAuthenticated()) {
      return;
    }
    if (elevated && deadline !== undefined && deadline <= Date.now()) {
      revoke();
      return;
    }
    const request = ++generation;
    try {
      const status = await getAuthStatus();
      if (stopped || request !== generation) {
        return;
      }
      const expiresAt = status.pinExpiresAt ? Date.parse(status.pinExpiresAt) : NaN;
      const active = status.isElevated && Number.isFinite(expiresAt) && expiresAt > Date.now();
      if (elevated && !active) {
        revoke();
        return;
      }
      elevated = active;
      deadline = active ? expiresAt : undefined;
      clearTimeout(timer);
      if (active) {
        // Other requests can extend the server deadline. A conservative full
        // reload at our last confirmed deadline reauthorizes all displayed data.
        timer = setTimeout(revoke, Math.min(expiresAt - Date.now(), 2_147_483_647));
      }
    } catch {
      if (!stopped && request === generation && elevated) {
        revoke();
      }
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
  };
  const unsubscribe = eventManager.on({
    AuthUserLoaded: refresh,
    WebsocketConnect: refresh,
    SessionAccessChanged: ({ isElevated }) => (isElevated ? refresh() : revoke()),
    SessionLocked: revoke,
    UserPinCodeReset: revoke,
  });
  const onRefresh = () => void refresh();
  addEventListener('focus', onRefresh);
  addEventListener('pageshow', onRefresh);
  document.addEventListener('visibilitychange', onVisible);
  void refresh();

  return {
    refresh,
    dispose: () => {
      stopped = true;
      generation++;
      clearTimeout(timer);
      unsubscribe();
      removeEventListener('focus', onRefresh);
      removeEventListener('pageshow', onRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
};
