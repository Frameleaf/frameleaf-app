import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AccountSetupTool from '$lib/components/frameleaf/setup/AccountSetupTool.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: true,
    user: { id: 'user-1', name: 'Jamie', email: 'jamie@example.test', isAdmin: false },
    preferences: {
      emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
      memories: { enabled: true },
    },
    load: vi.fn(),
  },
}));

describe('Set up your account (FL-176)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sdkMock.getFrameleafAccountLink.mockResolvedValue({ linked: false, available: false } as never);
    sdkMock.updateMyPreferences.mockResolvedValue({} as never);
    sdkMock.setUserOnboarding.mockResolvedValue({} as never);
  });

  it('shows every section on the dark stage and counts what is done', async () => {
    const { container } = render(AccountSetupTool);
    expect(container.querySelector('section.frs-tool-root')?.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('heading', { name: 'Set up your account' })).toBeInTheDocument();
    for (const title of ['Profile', 'Appearance', 'Privacy and notifications', 'The mobile app']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Link your Frameleaf account' })).toBeInTheDocument();
    expect(screen.getByLabelText('0 of 5 done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', '/auth/logout');

    await fireEvent.click(screen.getByRole('switch', { name: 'Memories' }));
    const privacy = container.querySelector('[data-section="privacy"]')!;
    await fireEvent.click(privacy.querySelector('footer button')!);
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: {
          emailNotifications: { albumUpdate: true, enabled: true },
          memories: { enabled: false },
        },
      }),
    );
    expect(await screen.findByLabelText('1 of 5 done')).toBeInTheDocument();
  });

  it('marks the account onboarded when done', async () => {
    render(AccountSetupTool);
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(sdkMock.setUserOnboarding).toHaveBeenCalledWith({ onboardingDto: { isOnboarded: true } }),
    );
    expect(goto).toHaveBeenCalledWith('/photos', { invalidateAll: true });
  });
});
