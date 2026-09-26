import { lockAuthSession } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionAccess, setSessionLockPending } from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock, watchSessionLockOwner } from '$lib/frameleaf/session-lock';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { revokeSessionView } from '$lib/utils/session-privacy';

vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), lockAuthSession: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos'), params: {} } }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({
  assetCacheManager: { invalidate: vi.fn(), revoke: vi.fn() },
}));
vi.mock('$lib/utils/session-privacy', () => ({ clearSessionMedia: vi.fn(), revokeSessionView: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ isAssetViewerRoute: () => false, navigate: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const sdkStatus = async (status: number) => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return sdk.lockAuthSession({ fetch: async () => Response.json({ message: 'nope' }, { status }) });
};

describe('requestSessionLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionLockPending(false);
    sessionAccess.lockStatus = 'idle';
  });

  it('keeps the barrier and reports the failure in the shield when the lock fails', async () => {
    vi.mocked(lockAuthSession).mockImplementationOnce(() => sdkStatus(503));
    const locking = requestSessionLock();
    expect(sessionAccess.lockStatus).toBe('locking');
    await locking;
    expect(sessionAccess.lockPending).toBe(true);
    expect(sessionAccess.lockStatus).toBe('failed');
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBe('true');
    expect(revokeSessionView).not.toHaveBeenCalled();
  });

  it('treats a 401 as final: drops the barrier and signs out', async () => {
    vi.mocked(lockAuthSession).mockImplementationOnce(() => sdkStatus(401));
    await requestSessionLock();
    expect(sessionAccess.lockPending).toBe(false);
    expect(sessionAccess.lockStatus).toBe('idle');
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBeNull();
    expect(revokeSessionView).toHaveBeenCalledExactlyOnceWith('/auth/logout');
    expect(handleError).not.toHaveBeenCalled();
  });

  it.each(['AuthLogout', 'AuthLogin'] as const)('drops a stale pending lock on %s', (event) => {
    const stop = watchSessionLockOwner();
    setSessionLockPending(true);
    sessionAccess.lockStatus = 'failed';
    if (event === 'AuthLogout') {
      eventManager.emit('AuthLogout');
    } else {
      eventManager.emit('AuthLogin', {} as never);
    }
    expect(sessionAccess.lockPending).toBe(false);
    expect(sessionAccess.lockStatus).toBe('idle');
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBeNull();
    stop();
  });

  it('releases the barrier once the server confirms the lock', async () => {
    vi.mocked(lockAuthSession).mockResolvedValueOnce(undefined as never);
    await requestSessionLock();
    expect(sessionAccess.lockPending).toBe(false);
    expect(sessionAccess.lockStatus).toBe('idle');
    expect(revokeSessionView).toHaveBeenCalledWith('/photos');
    // an access boundary: fetches still in flight must be rejected, not just uncached
    expect(assetCacheManager.revoke).toHaveBeenCalled();
    expect(assetCacheManager.invalidate).not.toHaveBeenCalled();
  });
});
