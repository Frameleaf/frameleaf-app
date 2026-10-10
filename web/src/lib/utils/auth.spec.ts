import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '$lib/utils/auth';

const auth = vi.hoisted(() => ({ authenticated: true, user: { isAdmin: true }, load: vi.fn() }));
const server = vi.hoisted(() => ({ value: { isInitialized: true, isOnboarded: false } }));
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

  it('does not loop on the setup page itself', async () => {
    await expect(authenticate(at('/auth/onboarding'))).resolves.toBeUndefined();
  });
});
