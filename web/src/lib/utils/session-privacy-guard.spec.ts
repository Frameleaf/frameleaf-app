import { getAuthStatus } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { revokeSessionView } from '$lib/utils/session-privacy';
import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';

vi.mock('@immich/sdk', () => ({ getAuthStatus: vi.fn() }));
vi.mock('$lib/utils/session-privacy', () => ({ revokeSessionView: vi.fn() }));
const status = (active: boolean) => ({
  isElevated: active,
  pinCode: true,
  password: true,
  pinExpiresAt: active ? new Date(Date.now() + 1000).toISOString() : undefined,
});

describe('watchSessionPrivacy', () => {
  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });
  afterEach(() => {
    guard?.dispose();
    vi.useRealTimers();
  });

  it('clears at the known expiry even while status revalidation is stalled', async () => {
    vi.mocked(getAuthStatus).mockResolvedValueOnce(status(true));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getAuthStatus).mockImplementationOnce(() => new Promise(() => {}));
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('clears on resume when the deadline elapsed while timers were suspended', async () => {
    vi.mocked(getAuthStatus).mockResolvedValueOnce(status(true));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 2000);
    dispatchEvent(new Event('focus'));
    expect(revokeSessionView).toHaveBeenCalledOnce();
    expect(getAuthStatus).toHaveBeenCalledOnce();
  });

  it('detects a missed lock on websocket reconnect', async () => {
    vi.mocked(getAuthStatus).mockResolvedValueOnce(status(true)).mockResolvedValueOnce(status(false));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    eventManager.emit('WebsocketConnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('does not let an older elevated response supersede a newer revoked response', async () => {
    vi.mocked(getAuthStatus).mockResolvedValueOnce(status(true));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (value: Awaited<ReturnType<typeof getAuthStatus>>) => void;
    const stale = new Promise<Awaited<ReturnType<typeof getAuthStatus>>>((done) => (resolve = done));
    vi.mocked(getAuthStatus).mockReturnValueOnce(stale).mockResolvedValueOnce(status(false));
    const first = guard.refresh();
    await guard.refresh();
    resolve(status(true));
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeSessionView).toHaveBeenCalledOnce();
  });

  it('fails closed when an elevated session cannot be revalidated', async () => {
    vi.mocked(getAuthStatus).mockResolvedValueOnce(status(true)).mockRejectedValueOnce(new Error('offline'));
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

  it('cleans up the timer and listeners when the root is destroyed', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(status(true));
    guard = watchSessionPrivacy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    guard.dispose();
    dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getAuthStatus).toHaveBeenCalledOnce();
    expect(revokeSessionView).not.toHaveBeenCalled();
  });
});
