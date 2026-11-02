import { getAuthStatus } from '@frameleaf/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import { discardAuthStatusReads, readAuthStatus } from '$lib/utils/auth-status-read';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getAuthStatus: vi.fn(),
}));

const locked = { isElevated: false, pinCode: true, password: true };

describe('readAuthStatus (FL-647)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    discardAuthStatusReads();
    vi.mocked(getAuthStatus).mockResolvedValue(locked);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('always sends a fresh read for the privacy guard', async () => {
    await Promise.all([readAuthStatus('fresh'), readAuthStatus('fresh')]);
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('lets a passive reader join a read in flight, but not one already finished', async () => {
    const first = readAuthStatus('fresh');
    const joined = readAuthStatus('passive');
    expect(joined).toBe(first);
    await first;
    await readAuthStatus('passive');
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('answers a page opening with a read that finished moments ago', async () => {
    await readAuthStatus('fresh');
    await readAuthStatus('recent');
    expect(getAuthStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2500);
    await readAuthStatus('recent');
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('never reuses a read started before a lock or after it was discarded', async () => {
    await readAuthStatus('fresh');
    sessionAccess.revision++;
    await readAuthStatus('recent');
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
    discardAuthStatusReads();
    await readAuthStatus('recent');
    expect(getAuthStatus).toHaveBeenCalledTimes(3);
  });

  it('does not share a failed read', async () => {
    vi.mocked(getAuthStatus).mockRejectedValueOnce(new Error('offline'));
    await expect(readAuthStatus('fresh')).rejects.toThrow('offline');
    await readAuthStatus('recent');
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('reads the server time from the response', async () => {
    vi.mocked(getAuthStatus).mockImplementationOnce(async (opts) => {
      await opts?.fetch?.('/api/auth/status');
      return locked;
    });
    const date = new Date('2026-10-29T12:00:00Z');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { headers: { Date: date.toUTCString() } }));
    const read = await readAuthStatus('fresh');
    expect(read.serverTime).toBe(date.getTime());
    expect(vi.mocked(getAuthStatus).mock.calls[0][0]).toMatchObject({ cache: 'no-store' });
    fetchSpy.mockRestore();
  });
});
