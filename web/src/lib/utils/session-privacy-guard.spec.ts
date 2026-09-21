import { getAuthStatus } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { revokeSessionView } from '$lib/utils/session-privacy';
import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';

vi.mock('@immich/sdk', () => ({ getAuthStatus: vi.fn() }));
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

  it('keeps initial elevated content gated if the server Date header is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    const gate = vi.fn();
    vi.mocked(getAuthStatus).mockImplementationOnce(respond(status(true)));
    guard = watchSessionPrivacy(() => true, gate);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).toHaveBeenLastCalledWith('error');
    expect(gate).not.toHaveBeenCalledWith('ready');
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
