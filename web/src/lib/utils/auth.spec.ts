import { getStorage, type ServerStorageResponseDto } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userInteraction } from '$lib/stores/user.svelte';
import { authenticate, requestServerInfo } from '$lib/utils/auth';
import { deferredPromise } from '@test-data/deferred';

const session = vi.hoisted(() => ({ generation: 0 }));
const auth = vi.hoisted(() => ({
  authenticated: true,
  user: { isAdmin: true },
  load: vi.fn(),
  captureSession: () => {
    const generation = session.generation;
    return () => generation === session.generation;
  },
}));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getStorage: vi.fn(),
}));
const server = vi.hoisted(() => ({
  value: { isInitialized: true, isOnboarded: false },
  ready: () => Promise.resolve(server.value),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({ serverConfigManager: server }));

const at = (path: string) => new URL(`http://localhost${path}`);

describe('authenticate: Frameleaf setup (FL-176)', () => {
  beforeEach(() => {
    auth.authenticated = true;
    auth.user.isAdmin = true;
    server.value = { isInitialized: true, isOnboarded: false };
  });

  it('sends an administrator to setup from admin and library pages while setup is incomplete', async () => {
    await expect(authenticate(at('/admin/users'), { admin: true })).rejects.toMatchObject({
      status: 307,
      location: '/auth/onboarding',
    });
    await expect(authenticate(at('/photos'))).rejects.toMatchObject({ location: '/auth/onboarding' });
  });

  it('lets the administrator through once setup is complete', async () => {
    server.value = { isInitialized: true, isOnboarded: true };
    await expect(authenticate(at('/admin/users'), { admin: true })).resolves.toBeUndefined();
  });

  it('never blocks other accounts', async () => {
    auth.user.isAdmin = false;
    await expect(authenticate(at('/photos'))).resolves.toBeUndefined();
  });

  it('does not read the path of a signed-in page once setup is complete', async () => {
    // a route load that reads the path runs again whenever it changes, such as opening an item
    server.value = { isInitialized: true, isOnboarded: true };
    let reads = 0;
    const url = {
      get pathname() {
        reads++;
        return '/albums/album-1/photos/asset-1';
      },
      search: '',
    } as URL;
    await expect(authenticate(url)).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('does not loop on the setup page itself', async () => {
    await expect(authenticate(at('/auth/onboarding'))).resolves.toBeUndefined();
  });
});

it.each([false, true])(
  'publishes storage information only for its requesting session (changed=%s)',
  async (changed) => {
    const response = deferredPromise<ServerStorageResponseDto>();
    const storage = {
      diskAvailable: '1 GiB',
      diskAvailableRaw: 1,
      diskSize: '2 GiB',
      diskSizeRaw: 2,
      diskUsagePercentage: 50,
      diskUse: '1 GiB',
      diskUseRaw: 1,
    };
    auth.authenticated = true;
    userInteraction.serverInfo = undefined;
    vi.mocked(getStorage).mockReturnValueOnce(response.promise);
    const loading = requestServerInfo();
    if (changed) {
      session.generation++;
      auth.authenticated = false;
    }
    response.resolve(storage);
    await loading;
    expect(userInteraction.serverInfo).toEqual(changed ? undefined : storage);
  },
);
