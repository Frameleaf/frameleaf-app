import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { userAdminFactory } from '@test-data/factories/user-factory';
import SetupFrameleafLink from '../setup/SetupFrameleafLink.svelte';
import FrameleafAccountSection from './FrameleafAccountSection.svelte';
import SignInProviderSection from './SignInProviderSection.svelte';

vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { oauthAccountManagementUrl: '' } },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { passwordLogin: true } },
}));
beforeEach(() => {
  vi.resetAllMocks();
  authManager.reset();
  authManager.setUser(userAdminFactory.build({ oauthId: '' }));
  sdkMock.getFrameleafAccountLink.mockResolvedValue({
    available: true,
    linked: false,
    email: null,
    linkedAt: null,
    lastSignInAt: null,
  });
  sdkMock.getPublicConfig.mockResolvedValue({ frameleaf: { signInAvailable: true } } as Awaited<
    ReturnType<typeof sdkMock.getPublicConfig>
  >);
  vi.mocked(confirmFrameleaf).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

it.each(['account', 'provider', 'setup'] as const)('does not redirect after closing the %s caller', async (kind) => {
  const pending = deferredPromise<{ url: string }>();
  const assign = vi.fn();
  vi.stubGlobal('location', { assign, href: location.href, origin: location.origin, search: location.search });
  sdkMock.startFrameleafSignIn.mockReturnValue(pending.promise);
  sdkMock.startOAuth.mockReturnValue(pending.promise);
  const view =
    kind === 'account'
      ? render(FrameleafAccountSection)
      : kind === 'provider'
        ? render(SignInProviderSection)
        : render(SetupFrameleafLink, { mode: 'sign-in', linked: false, onLinked: vi.fn() });
  const label =
    kind === 'account'
      ? 'frameleaf_personal_link'
      : kind === 'provider'
        ? 'frameleaf_access_provider_connect'
        : 'frameleaf_setup_sign_in_frameleaf';
  const button = await screen.findByRole('button', { name: label });
  await waitFor(() => expect(button).not.toBeDisabled());
  await fireEvent.click(button);
  await waitFor(() =>
    expect(kind === 'provider' ? sdkMock.startOAuth : sdkMock.startFrameleafSignIn).toHaveBeenCalledOnce(),
  );
  view.unmount();
  pending.resolve({ url: 'https://provider.test/auth?state=late' });
  await pending.promise;
  await tick();
  expect(assign).not.toHaveBeenCalled();
});

it.each(['account', 'provider'] as const)('does not redirect a %s result in another session', async (kind) => {
  const pending = deferredPromise<{ url: string }>();
  const assign = vi.fn();
  vi.stubGlobal('location', { assign, href: location.href, origin: location.origin, search: location.search });
  sdkMock.startFrameleafSignIn.mockReturnValue(pending.promise);
  sdkMock.startOAuth.mockReturnValue(pending.promise);
  if (kind === 'account') {
    render(FrameleafAccountSection);
  } else {
    render(SignInProviderSection);
  }
  const button = await screen.findByRole('button', {
    name: kind === 'account' ? 'frameleaf_personal_link' : 'frameleaf_access_provider_connect',
  });
  await waitFor(() => expect(button).not.toBeDisabled());
  await fireEvent.click(button);
  authManager.reset();
  authManager.setUser(userAdminFactory.build({ oauthId: '' }));
  pending.resolve({ url: 'https://provider.test/auth?state=late' });
  await pending.promise;
  await tick();
  expect(assign).not.toHaveBeenCalled();
});

it.each([false, true])('does not act on a retired Frameleaf account confirmation (unlink: %s)', async (unlink) => {
  const pending = deferredPromise<boolean>();
  vi.mocked(confirmFrameleaf).mockReturnValue(pending.promise);
  sdkMock.getFrameleafAccountLink.mockResolvedValue({
    available: true,
    linked: unlink,
    email: null,
    linkedAt: null,
    lastSignInAt: null,
  });
  const view = render(FrameleafAccountSection);
  const button = await screen.findByRole('button', {
    name: unlink ? 'frameleaf_personal_unlink' : 'frameleaf_personal_link',
  });
  await waitFor(() => expect(button).not.toBeDisabled());
  await fireEvent.click(button);
  view.unmount();
  pending.resolve(true);
  await pending.promise;
  await tick();
  expect(sdkMock.startFrameleafSignIn).not.toHaveBeenCalled();
  expect(sdkMock.unlinkFrameleafAccount).not.toHaveBeenCalled();
});
