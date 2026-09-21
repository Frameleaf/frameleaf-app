import { getAuthStatus } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { revokeSessionView } from '$lib/utils/session-privacy';

/** Event-driven revalidation; the expiry deadline never waits for a network response. */
export const watchSessionPrivacy = (
  isAuthenticated: () => boolean,
  onInitialStatus: (status: 'pending' | 'ready' | 'error') => void = () => {},
  revalidatePreloadedData: () => Promise<void> = async () => {},
) => {
  let verified = false;
  let elevated = false;
  let stopped = false;
  let generation = 0;
  let deadline: number | undefined;
  let wallDeadline: number | undefined;
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
    if (stopped) {
      return;
    }
    if (!isAuthenticated()) {
      onInitialStatus('ready');
      return;
    }
    if (!verified) {
      onInitialStatus('pending');
    }
    if (
      elevated &&
      ((deadline !== undefined && deadline <= performance.now()) ||
        (wallDeadline !== undefined && wallDeadline <= Date.now()))
    ) {
      revoke();
      return;
    }
    const request = ++generation;
    try {
      const started = performance.now();
      let serverTime = NaN;
      const status = await getAuthStatus({
        cache: 'no-store',
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          serverTime = Date.parse(response.headers.get('Date') ?? '');
          return response;
        },
      });
      if (stopped || request !== generation) {
        return;
      }
      const expiresAt = status.pinExpiresAt ? Date.parse(status.pinExpiresAt) : NaN;
      // HTTP Date has whole-second precision. Subtract its rounding interval
      // and the entire request duration; a slow or changed client clock cannot
      // extend elevation. Fail closed if the server time cannot be established.
      const remaining = expiresAt - serverTime - 1000 - (performance.now() - started);
      if (status.isElevated && !Number.isFinite(remaining)) {
        throw new Error('Unable to verify session expiry');
      }
      const active = status.isElevated && remaining > 0;
      if ((elevated || status.isElevated) && !active) {
        revoke();
        return;
      }
      elevated = active;
      deadline = active ? performance.now() + remaining : undefined;
      // Wall elapsed time also covers platforms that suspend their monotonic
      // clock during device sleep. Clock changes can clear early, never extend.
      wallDeadline = active ? Date.now() + remaining : undefined;
      clearTimeout(timer);
      if (active) {
        // Other requests can extend the server deadline. A conservative full
        // reload at our last confirmed deadline reauthorizes all displayed data.
        timer = setTimeout(revoke, Math.min(remaining, 2_147_483_647));
      }
      if (!verified && !active) {
        // Layout loaders can have completed while the session was elevated.
        // Do not mount those results merely because the first status is locked.
        await revalidatePreloadedData();
        if (stopped || request !== generation) {
          return;
        }
      }
      verified = true;
      onInitialStatus('ready');
    } catch {
      if (!stopped && request === generation && elevated) {
        revoke();
      } else if (!stopped && request === generation && !verified) {
        onInitialStatus('error');
      }
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
  };
  const unsubscribe = eventManager.on({
    AuthUserLoaded: () => {
      verified = false;
      return refresh();
    },
    AuthLogout: () => {
      generation++;
      clearTimeout(timer);
      elevated = false;
      verified = false;
      deadline = undefined;
      wallDeadline = undefined;
      onInitialStatus('ready');
    },
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
