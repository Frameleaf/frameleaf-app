import { getAuthStatus, lockAuthSession } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionAccess, setSessionLockPending, trackSessionUnlock } from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock } from '$lib/frameleaf/session-lock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { revokeSessionView } from '$lib/utils/session-privacy';
import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';

// FL-34: ported from PR131 bebfed12ff and 25990c373c (d7cfe8b1a7), adapted to the current Locked flow

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  getAuthStatus: vi.fn(),
  lockAuthSession: vi.fn(),
}));
vi.mock('$lib/frameleaf/session-lock', () => ({ requestSessionLock: vi.fn() }));
vi.mock('$lib/utils/session-privacy', () => ({ revokeSessionView: vi.fn() }));
const respond =
  (value: Awaited<ReturnType<typeof getAuthStatus>>) => async (opts?: Parameters<typeof getAuthStatus>[0]) => {
    await opts?.fetch?.('/api/auth/status');
    return value;
  };

const status = (active: boolean) => ({
  isElevated: active,
  pinCode: true,
  password: true,
  pinExpiresAt: active ? new Date(Date.now() + 10_000).toISOString() : undefined,
});

describe('watchSessionPrivacy', () => {
  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;
  beforeEach(() => {
    setSessionLockPending(false);
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { headers: { Date: new Date().toUTCString() } }),
    );
  });
  afterEach(() => {
    guard?.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([-86_400_000, 86_400_000])('uses server time with a client clock skew of %i ms', async (skew) => {
    const authoritative = status(true);
    vi.setSystemTime(Date.now() + skew);
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(authoritative));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9000);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('keeps initial content gated on failure, and allows an explicit successful retry', async () => {
    const gate = vi.fn();
    vi.mocked(getAuthStatus).mockRejectedValueOnce(new Error('offline'));
    guard = watchSessionPrivacy(() => true, gate);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.mock.calls.map(([state]) => state)).toEqual(['pending', 'error']);
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    await guard.refresh();
    expect(gate).toHaveBeenLastCalledWith('ready');
  });

  it('does not release preloaded elevated route data when its first status is locked', async () => {
    const gate = vi.fn();
    const revalidate = vi.fn().mockRejectedValue(new Error('preloaded asset is no longer authorized'));
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true, gate, revalidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenLastCalledWith('error');
    expect(gate).not.toHaveBeenCalledWith('ready');
  });

  it('waits for locked route data to be fetched again before releasing the initial gate', async () => {
    const gate = vi.fn();
    let finish!: () => void;
    const reloading = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(
      () => true,
      gate,
      () => reloading,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).not.toHaveBeenCalledWith('ready');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).toHaveBeenLastCalledWith('ready');
  });

  // Review P3-6: reloading would get the same unbounded answer and loop, so the elevation is ended
  it('ends an elevation it cannot bound on the first check instead of reloading', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    vi.mocked(lockAuthSession).mockResolvedValue(undefined as never);
    const gate = vi.fn();
    const revalidate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true, gate, revalidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(revokeSessionView).not.toHaveBeenCalled();
    // continues as a locked view: preloaded data is checked again before anything is released
    expect(revalidate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenLastCalledWith('ready');
  });

  it('ends an elevation whose server clock puts it past expiry on the first check, without a reload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', { headers: { Date: new Date(Date.now() + 60_000).toUTCString() } }),
    );
    vi.mocked(lockAuthSession).mockResolvedValue(undefined as never);
    const gate = vi.fn();
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true, gate);
    await vi.advanceTimersByTimeAsync(0);
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(revokeSessionView).not.toHaveBeenCalled();
    expect(gate).toHaveBeenLastCalledWith('ready');
  });

  it('keeps initial content held if the unbounded elevation cannot be ended', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    vi.mocked(lockAuthSession).mockRejectedValue(new Error('offline'));
    const gate = vi.fn();
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true, gate);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).toHaveBeenLastCalledWith('error');
    expect(gate).not.toHaveBeenCalledWith('ready');
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  // Review P2-1: the caller left the page (the asset in the URL is not the caller's to see)
  it('releases nothing when re-checking the preloaded data replaced the page', async () => {
    const gate = vi.fn();
    vi.mocked(getAuthStatus).mockImplementation(respond(status(false)));
    guard = watchSessionPrivacy(
      () => true,
      gate,
      async () => 'replaced',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).not.toHaveBeenCalledWith('ready');
    expect(gate).not.toHaveBeenCalledWith('error');
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getAuthStatus).toHaveBeenCalledOnce();
  });

  // Review P3-7: a cold load's navigation and focus share the first check
  it('lets passive rechecks join a check already in flight', async () => {
    let finish!: (value: Awaited<ReturnType<typeof getAuthStatus>>) => void;
    vi.mocked(getAuthStatus).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    guard = watchSessionPrivacy(() => true);
    const joined = guard.revalidate();
    dispatchEvent(new Event('focus'));
    finish(status(false));
    await joined;
    expect(getAuthStatus).toHaveBeenCalledOnce();
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    await guard.revalidate();
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('clears at the known expiry even while status revalidation is stalled', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getAuthStatus).mockImplementationOnce(() => new Promise(() => {}));
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(9000);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('clears on resume when the deadline elapsed while timers were suspended', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, 'now').mockReturnValue(20_000);
    dispatchEvent(new Event('focus'));
    expect(revokeSessionView).toHaveBeenCalledOnce();
    expect(getAuthStatus).toHaveBeenCalledOnce();
  });

  it('detects a missed lock on websocket reconnect', async () => {
    vi.mocked(getAuthStatus)
      .mockImplementationOnce(respond(status(true)))
      .mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    eventManager.emit('WebsocketConnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('does not let an older elevated response supersede a newer revoked response', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (value: Awaited<ReturnType<typeof getAuthStatus>>) => void;
    const stale = new Promise<Awaited<ReturnType<typeof getAuthStatus>>>((done) => (resolve = done));
    vi.mocked(getAuthStatus)
      .mockReturnValueOnce(stale)
      .mockImplementationOnce(respond(status(false)));
    const first = guard.refresh();
    await guard.refresh();
    resolve(status(true));
    await first;
    await vi.advanceTimersByTimeAsync(9000);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('fails closed when an elevated session cannot be revalidated', async () => {
    vi.mocked(getAuthStatus)
      .mockImplementationOnce(respond(status(true)))
      .mockRejectedValueOnce(new Error('offline'));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    await guard.refresh();
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('does not start authenticated checks on signed-out views', async () => {
    guard = watchSessionPrivacy(() => false);
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('discards the previous account deadline when signing out', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    eventManager.emit('AuthLogout');
    await vi.advanceTimersByTimeAsync(9000);
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  // FL-34 adaptation: a lock anywhere (this tab, another tab via `on_session_lock`, a PIN reset)
  // discards an elevated view; a view that was never elevated has nothing to discard and rechecks
  it.each(['SessionLocked', 'SessionLockedRemote', 'UserPinCodeReset'] as const)(
    'discards an elevated view on %s',
    async (event) => {
      vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
      guard = watchSessionPrivacy(() => true);
      await vi.advanceTimersByTimeAsync(0);
      eventManager.emit(event);
      expect(revokeSessionView).toHaveBeenCalledOnce();
      expect(revokeSessionView).toHaveBeenCalledWith('/photos');
    },
  );

  it('discards an elevated view when this tab locks it', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    eventManager.emit('SessionAccessChanged', { isElevated: false });
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it.each(['SessionLocked', 'SessionLockedRemote', 'UserPinCodeReset'] as const)(
    'only rechecks a view that was not elevated on %s',
    async (event) => {
      vi.mocked(getAuthStatus).mockImplementation(respond(status(false)));
      guard = watchSessionPrivacy(() => true);
      await vi.advanceTimersByTimeAsync(0);
      eventManager.emit(event);
      await vi.advanceTimersByTimeAsync(0);
      expect(revokeSessionView).not.toHaveBeenCalled();
      expect(getAuthStatus).toHaveBeenCalledTimes(2);
    },
  );

  it('reloads where the caller says a revoked view goes', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(
      () => true,
      () => {},
      async () => {},
      () => '/albums?filter=mine',
    );
    await vi.advanceTimersByTimeAsync(9000);
    expect(revokeSessionView).toHaveBeenCalledWith('/albums?filter=mine');
  });

  // FL-80/FL-83 grafts from the reviewed browser privacy recovery (7bd8751ec2, ab2b56c315)
  it('holds initial verification while a persisted local lock is pending, then revalidates', async () => {
    const gate = vi.fn();
    const revalidate = vi.fn().mockResolvedValue(undefined);
    setSessionLockPending(true);
    guard = watchSessionPrivacy(() => true, gate, revalidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalledWith('ready');
    setSessionLockPending(false);
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    await guard.refresh();
    expect(revalidate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenLastCalledWith('ready');
  });

  it('leaves a local lock behind its persisted shield instead of reloading before it settles', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    setSessionLockPending(true);
    eventManager.emit('SessionLocked');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(revokeSessionView).not.toHaveBeenCalled();
    setSessionLockPending(false);
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    await guard.refresh();
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('routes a revocation through the single local lock while an unlock request is in flight', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    vi.mocked(requestSessionLock).mockImplementation(() => {
      setSessionLockPending(true);
      return Promise.resolve();
    });
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: () => void;
    const unlock = trackSessionUnlock(new Promise<void>((resolve) => (finish = resolve)));
    eventManager.emit('SessionLockedRemote');
    expect(requestSessionLock).toHaveBeenCalledOnce();
    // the persisted barrier, not a reload, owns the document until the unlock settles
    expect(revokeSessionView).not.toHaveBeenCalled();
    finish();
    await unlock;
  });

  it('preserves a verified locked page on credential revocation and retires an older status response', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: ReturnType<typeof status>) => void;
    vi.mocked(getAuthStatus)
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementation(respond(status(false)));
    const pending = guard.refresh();
    eventManager.emit('UserPinCodeReset');
    finish(status(true));
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('revokes newly requested elevation before its status check can settle', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: ReturnType<typeof status>) => void;
    vi.mocked(getAuthStatus).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    eventManager.emit('SessionLocked');
    expect(revokeSessionView).toHaveBeenCalledOnce();
    finish(status(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('does not silently accept a requested elevation the server reports as locked', async () => {
    vi.mocked(getAuthStatus)
      .mockImplementationOnce(respond(status(false)))
      .mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('fails closed when a newly completed unlock cannot establish a verified deadline', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getAuthStatus).mockRejectedValueOnce(new Error('offline'));
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('retires the guard and pending PIN callbacks when the session is deleted', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    const revision = sessionAccess.revision;
    eventManager.emit('SessionDelete');
    expect(sessionAccess.revision).toBeGreaterThan(revision);
    expect(sessionAccess.isElevated).toBe(false);
    // the auth manager owns the sign-out navigation; the guard's deadline no longer fires
    await vi.advanceTimersByTimeAsync(20_000);
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it.each(['focus', 'reconnect'])('signs out on an authoritative 401 status on %s while locked', async (signal) => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockImplementationOnce(() =>
      sdk.getAuthStatus({
        fetch: async () => Response.json({ message: 'Invalid user token' }, { status: 401 }),
      }),
    );
    if (signal === 'focus') {
      dispatchEvent(new Event('focus'));
    } else {
      eventManager.emit('WebsocketConnect');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledExactlyOnceWith('/auth/logout');
  });

  it('signs out when remote access needs a Frameleaf sign-in (FL-161)', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockImplementationOnce(() =>
      sdk.getAuthStatus({
        fetch: async () =>
          Response.json(
            {
              message: 'Away from home, sign in with your Frameleaf account to use this server',
              code: 'frameleaf_sign_in_required',
            },
            { status: 403 },
          ),
      }),
    );
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledExactlyOnceWith('/auth/logout');
  });

  it('does not sign out on any other refusal', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockImplementationOnce(() =>
      sdk.getAuthStatus({
        fetch: async () => Response.json({ message: 'Forbidden' }, { status: 403 }),
      }),
    );
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('keeps an ordinary offline status error distinct from deleted authentication while locked', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(false)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getAuthStatus).mockRejectedValueOnce(new TypeError('offline'));
    await guard.refresh();
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('cleans up the timer and listeners when the root is destroyed', async () => {
    vi.mocked(getAuthStatus).mockImplementation(respond(status(true)));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    guard.dispose();
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(9000);
    expect(getAuthStatus).toHaveBeenCalledOnce();
    expect(revokeSessionView).not.toHaveBeenCalled();
  });
});
