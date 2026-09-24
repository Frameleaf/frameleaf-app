import { setUserOnboarding, updateAdminOnboarding } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { Route } from '$lib/route';
import en from '../../../../../i18n/en.json';
import OnboardingPage from './+page.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
const state = $state({ url: new URL('http://localhost/auth/onboarding') });
vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({
  get page() {
    return state;
  },
}));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  setUserOnboarding: vi.fn(),
  updateAdminOnboarding: vi.fn(),
  updateMyPreferences: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: true,
    user: { id: 'user-1', name: 'Taylor', isAdmin: false },
    preferences: { cast: { gCastEnabled: false, adminDisabled: false }, memories: { enabled: true } },
    setPreferences: vi.fn(),
  },
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { isOnboarded: true }, loadServerConfig: vi.fn() },
}));

describe('onboarding page (FL-80 ON-1)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    localStorage.clear();
    navigation.goto.mockReset();
    state.url = new URL('http://localhost/auth/onboarding');
  });

  it('shows the step rail with only reached steps enabled, and Step n of N', async () => {
    render(OnboardingPage);

    const rail = screen.getByRole('navigation', { name: 'Setup steps' });
    const welcome = await waitFor(() => screen.getByRole('button', { name: /Welcome/ }));
    expect(rail).toContainElement(welcome);
    expect(welcome).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /Language/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Storage/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Step 1 of 7').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
  });

  it('moves with Next and Alt + arrow keys, and finishes later without onboarding', async () => {
    render(OnboardingPage);

    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(navigation.goto).toHaveBeenLastCalledWith(Route.onboarding({ step: 'language' }), expect.anything());

    await fireEvent.keyDown(screen.getByRole('heading', { name: 'Welcome' }), { key: 'ArrowRight', altKey: true });
    expect(navigation.goto).toHaveBeenLastCalledWith(Route.onboarding({ step: 'language' }), expect.anything());

    await fireEvent.click(screen.getByRole('button', { name: 'Finish later' }));
    expect(navigation.goto).toHaveBeenLastCalledWith(Route.photos());
    expect(setUserOnboarding).not.toHaveBeenCalled();
  });

  it('resumes from the saved step and finishes on the summary', async () => {
    localStorage.setItem('frameleaf:onboarding:v1:user-1', JSON.stringify({ step: 'done', reached: 6 }));
    render(OnboardingPage);

    expect(await screen.findByRole('heading', { name: "You're all set" })).toBeInTheDocument();
    expect(screen.getByText('Your account is ready. Here is what you chose.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Language/ })).toBeEnabled();

    await fireEvent.click(screen.getByRole('button', { name: 'Open Frameleaf' }));
    await waitFor(() => expect(setUserOnboarding).toHaveBeenCalledWith({ onboardingDto: { isOnboarded: true } }));
    expect(updateAdminOnboarding).not.toHaveBeenCalled();
    expect(navigation.goto).toHaveBeenLastCalledWith(Route.photos());
    expect(localStorage.getItem('frameleaf:onboarding:v1:user-1')).toBeNull();
  });
});
