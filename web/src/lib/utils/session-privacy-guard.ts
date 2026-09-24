import { getAuthStatus, lockAuthSession } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { revokeSessionView } from '$lib/utils/session-privacy';

export type SessionPrivacyStatus = 'pending' | 'ready' | 'error';

/**
 * What re-checking the preloaded route data found: `'replaced'` means the caller already left the
 * page (for example the asset in the URL is no longer the caller's to see), so nothing is released.
 */
export type PreloadedDataResult = void | 'replaced';

/**
 * FL-34 (ported from PR131 bebfed12ff and 25990c373c): keeps what an elevated (PIN-unlocked) session
 * shows in step with the server.
 *
 * - The first view of an authenticated app is held (`pending`) until the session's status is
 *   verified, so content loaded while elevated is never shown after the session was locked
 *   elsewhere; a locked first status revalidates the preloaded route data before release.
 * - While elevated, the server's expiry is enforced locally at a conservative deadline (server
 *   `Date` minus rounding and request time) on both the monotonic and wall clocks, so neither a slow
 *   network nor a changed or suspended client clock can extend it.
 * - Focus, page show, visibility and websocket reconnect revalidate; a missed `on_session_lock`
 *   is caught there.
 * - Losing elevation (a lock here or in another tab or session, a PIN reset, the deadline, or an
 *   elevated session that can no longer be verified) discards the whole document through
 *   `revokeSessionView`, which clears media, Picture-in-Picture and downloads first. A session that
 *   was not elevated has nothing unlocked to discard and only revalidates.
 * - A first check that finds the session elevated but cannot establish how long for (no usable
 *   server `Date`) ends the elevation on the server and continues locked, instead of reloading:
 *   a reload would find the same answer and loop.
 * - Passive rechecks (navigation, focus, visibility) share a check already in flight; the status
 *   read never extends the elevation itself (`refreshElevation: false` on the server).
 *
 * Event-driven: the expiry deadline never waits for a network response.
 */
export const watchSessionPrivacy = (
  isAuthenticated: () => boolean,
  onInitialStatus: (status: SessionPrivacyStatus) => void = () => {},
  revalidatePreloadedData: () => Promise<PreloadedDataResult> = async () => {},
  destination: () => string = () => Route.photos(),
) => {
  let verified = false;
  let elevated = false;
  let stopped = false;
  let generation = 0;
  let deadline: number | undefined;
  let wallDeadline: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const revoke = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    generation++;
    clearTimeout(timer);
    revokeSessionView(destination());
  };

  // Only an elevated view holds anything a lock takes away; any other view just rechecks.
  const revokeIfElevated = () => (elevated ? revoke() : refresh());

  const refresh = () => {
    const current = check().finally(() => {
      if (inFlight === current) {
        inFlight = undefined;
      }
    });
    inFlight = current;
    return current;
  };

  // navigation, focus and visibility carry no news of their own: join a check already running
  const revalidate = () => inFlight ?? refresh();

  const check = async () => {
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
      let isElevated = status.isElevated;
      if (isElevated && !verified && !elevated && !(Number.isFinite(remaining) && remaining > 0)) {
        // An elevation this view cannot bound: end it rather than reload into the same answer.
        await lockAuthSession();
        if (stopped || request !== generation) {
          return;
        }
        isElevated = false;
      }
      if (isElevated && !Number.isFinite(remaining)) {
        throw new Error('Unable to verify session expiry');
      }
      const active = isElevated && remaining > 0;
      if ((elevated || isElevated) && !active) {
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
        const result = await revalidatePreloadedData();
        if (result === 'replaced') {
          // the caller is leaving this document; nothing of it is released
          stopped = true;
          return;
        }
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
      void revalidate();
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
    SessionAccessChanged: ({ isElevated }) => (isElevated ? refresh() : revokeIfElevated()),
    SessionLocked: revokeIfElevated,
    SessionLockedRemote: revokeIfElevated,
    UserPinCodeReset: revokeIfElevated,
  });
  const onRefresh = () => void revalidate();
  addEventListener('focus', onRefresh);
  addEventListener('pageshow', onRefresh);
  document.addEventListener('visibilitychange', onVisible);
  void refresh();

  return {
    refresh,
    revalidate,
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
