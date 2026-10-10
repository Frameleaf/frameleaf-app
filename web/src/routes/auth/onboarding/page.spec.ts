import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import { load } from './+page';
import Page from './+page.svelte';

const auth = vi.hoisted(() => ({
  authenticated: true,
  user: { id: 'admin-1', name: 'Ada', isAdmin: true, storageLabel: 'admin' },
  preferences: { emailNotifications: { enabled: true, albumUpdate: true }, memories: { enabled: true } },
  load: vi.fn(),
}));
const server = vi.hoisted(() => ({ value: { isInitialized: true, isOnboarded: false } }));

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({ serverConfigManager: server }));

const run = () =>
  load({ parent: () => Promise.resolve({}), url: new URL('http://localhost/auth/onboarding') } as never) as Promise<
    Record<string, unknown>
  >;

describe('/auth/onboarding (FL-176)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    auth.authenticated = true;
    auth.user.isAdmin = true;
    server.value = { isInitialized: true, isOnboarded: false };
    sdkMock.getFrameleafSetup.mockResolvedValue({
      completed: false,
      completedAt: null,
      flow: 'existing',
      progress: null,
    } as never);
  });

  it('gives an administrator setup while it is incomplete, in the flow the server reports', async () => {
    await expect(run()).resolves.toMatchObject({ mode: 'setup', flow: 'existing', signedIn: true });
  });

  it('gives other accounts the Set up your account tool, never setup', async () => {
    auth.user.isAdmin = false;
    await expect(run()).resolves.toMatchObject({ mode: 'account' });
    expect(sdkMock.getFrameleafSetup).not.toHaveBeenCalled();
  });

  it('passes on where sign-in was going, only within this app (FL-146, FL-30)', async () => {
    auth.user.isAdmin = false;
    const at = (query: string) =>
      load({
        parent: () => Promise.resolve({}),
        url: new URL(`http://localhost/auth/onboarding${query}`),
      } as never) as Promise<Record<string, unknown>>;
    await expect(at('?continue=%2Falbums%3Ffrom%3Dshare')).resolves.toMatchObject({ continueTo: '/albums?from=share' });
    await expect(at('?continue=https%3A%2F%2Fevil.example%2Fsteal')).resolves.toMatchObject({ continueTo: '/photos' });
    await expect(at('')).resolves.toMatchObject({ continueTo: '/photos' });
    // never another sign-in page, and never a path the router would read as another host (review P3)
    for (const target of ['/auth/onboarding', '/auth/logout', 'http%3A%2F%2Flocalhost%2F%2Fevil.example%2Fx']) {
      await expect(at(`?continue=${target}`)).resolves.toMatchObject({ continueTo: '/photos' });
    }
  });

  it('gives an administrator the tool once setup is complete', async () => {
    server.value = { isInitialized: true, isOnboarded: true };
    await expect(run()).resolves.toMatchObject({ mode: 'account' });
  });

  it('opens the existing-library sign-in when signed out, and sends others to sign in', async () => {
    auth.authenticated = false;
    await expect(run()).resolves.toMatchObject({ mode: 'setup', flow: 'existing', signedIn: false });
    server.value = { isInitialized: true, isOnboarded: true };
    await expect(run()).rejects.toMatchObject({ status: 307, location: '/auth/login?continue=%2Fauth%2Fonboarding' });
  });

  it('shows "Your library is safe" to a signed-in administrator of an existing library', () => {
    render(Page, {
      data: {
        mode: 'setup',
        flow: 'existing',
        signedIn: true,
        saved: { completed: false, completedAt: null, flow: 'existing', progress: null },
        meta: { title: '' },
      } as never,
    });
    // one heading, a sentence to a row: read as a whole by its name
    expect(
      screen.getByRole('heading', { level: 1, name: 'Welcome to Frameleaf. Your library is safe.' }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_setup_new_care)).toBeInTheDocument();
  });
});
