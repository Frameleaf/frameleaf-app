import { getAuthStatus, isHttpError, lockAuthSession } from '@immich/sdk';
import { hasPendingSessionUnlocks, sessionAccess } from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock } from '$lib/frameleaf/session-lock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { revokeSessionView } from '$lib/utils/session-privacy';

export type SessionPrivacyStatus = 'pending' | 'ready' | 'error';

/**
 * Whether the server says this sign-in no longer counts: a 401, or (FL-161) a 403
 * `frameleaf_sign_in_required` for a session that is not a Frameleaf sign-in, reached through remote
 * access. Either way the person has to sign in again, and the login page offers what works here.
 */
const isAuthenticationGone = (error: unknown) =>
  isHttpError(error) &&
  (error.status === 401 ||
    (error.status === 403 && (error.data as { code?: unknown } | undefined)?.code === 'frameleaf_sign_in_required'));

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
 * - FL-80/FL-83: a PIN unlock that was requested (`SessionAccessChanged`) but not yet verified is
 *   treated as elevated, so a lock, reset or failed check while it settles fails closed instead of
 *   silently accepting it. A revocation while an unlock request is still in flight goes through the
 *   single local lock (`requestSessionLock`), and while that persisted lock barrier is pending the
 *   barrier, not this guard, owns the document; the guard rechecks once it lifts.
 * - An authoritative 401 from the status read means the authentication itself is gone: sign out
 *   (distinct from an offline error, which only fails closed while elevated).
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
  // A PIN unlock this view heard about but has not verified yet: it fails closed like an elevation.
  let elevationRequested = false;
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
    if (hasPendingSessionUnlocks()) {
      // Do not abandon the SDK unlock by reloading: its server mutation can still complete.
      void requestSessionLock();
    }
    if (sessionAccess.lockPending) {
      // The persisted local barrier owns this revocation until the unlock and lock settle.
      generation++;
      clearTimeout(timer);
      elevated = false;
      elevationRequested = false;
      deadline = undefined;
      wallDeadline = undefined;
      return;
    }
    stopped = true;
    generation++;
    clearTimeout(timer);
    revokeSessionView(destination());
  };

  // Only an elevated view (or one whose unlock is requested or still in flight) holds anything a lock
  // takes away; any other view, including an already-locked page with a PIN or password form, just
  // rechecks.
  const revokeIfElevated = () => (elevated || elevationRequested || hasPendingSessionUnlocks() ? revoke() : refresh());

  /** The authentication itself is gone: nothing of this document may outlive it. */
  const revokeAuthentication = (discard: boolean) => {
    if (stopped) {
      return;
    }
    stopped = true;
    generation++;
    clearTimeout(timer);
    // Invalidate a pending PIN callback even when full navigation or its response stalls.
    sessionAccess.revision++;
    sessionAccess.isElevated = false;
    if (discard) {
      revokeSessionView(Route.logout());
    }
  };

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
    if (stopped || sessionAccess.lockPending) {
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
      if (stopped || request !== generation || sessionAccess.lockPending) {
        return;
      }
      const expiresAt = status.pinExpiresAt ? Date.parse(status.pinExpiresAt) : NaN;
      // HTTP Date has whole-second precision. Subtract its rounding interval
      // and the entire request duration; a slow or changed client clock cannot
      // extend elevation. Fail closed if the server time cannot be established.
      const remaining = expiresAt - serverTime - 1000 - (performance.now() - started);
      let isElevated = status.isElevated;
      if (
        isElevated &&
        !verified &&
        !elevated &&
        !elevationRequested &&
        !(Number.isFinite(remaining) && remaining > 0)
      ) {
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
      if ((elevated || isElevated || elevationRequested) && !active) {
        elevationRequested = true;
        revoke();
        return;
      }
      elevated = active;
      elevationRequested = false;
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
    } catch (error) {
      if (!stopped && request === generation && isAuthenticationGone(error)) {
        revokeAuthentication(true);
      } else if (!stopped && request === generation && (elevated || elevationRequested)) {
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
      elevationRequested = false;
      verified = false;
      deadline = undefined;
      wallDeadline = undefined;
      onInitialStatus('ready');
    },
    WebsocketConnect: refresh,
    SessionAccessChanged: ({ isElevated }) => {
      if (isElevated) {
        elevationRequested = true;
        return refresh();
      }
      return revokeIfElevated();
    },
    // the auth manager discards the document; retire this guard and any pending PIN callback
    SessionDelete: () => revokeAuthentication(false),
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
