import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
import { createSetup, flowSteps } from '$lib/frameleaf/first-run-setup';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

describe('FirstRunSetup (FL-176)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('runs on the dark stage and opens with the logo intro', async () => {
    const { container } = render(FirstRunSetup, { initial: createSetup('new'), authenticated: false });
    const root = container.querySelector('section.frs-root');
    expect(root?.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByText('Your photos, beautifully kept. On your own server.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Continue setup/ }));
    expect(await screen.findByRole('heading', { name: "How you'll sign in" })).toBeInTheDocument();
    expect(screen.getByText('Frameleaf account')).toBeInTheDocument();
    expect(screen.getByText('Local account only')).toBeInTheDocument();
    expect(root?.getAttribute('data-theme')).toBe('dark');
    // the chapter rail marks Welcome done and Account current
    expect(screen.getByRole('button', { name: /Account/, current: 'step' })).toBeInTheDocument();
  });

  it('keeps the admin on the account step until it is complete, without saving the password', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    render(FirstRunSetup, {
      initial: { ...state, step: account, reached: account, choices: { ...state.choices, signIn: 'local' } },
      authenticated: false,
    });
    expect(screen.getByRole('heading', { name: 'Create the admin account' })).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-9' } });
    await fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(sdkMock.signUpAdmin).not.toHaveBeenCalled();
    expect(localStorage.getItem('frameleaf:setup:v1')).not.toContain('Correct-Horse-9');
  });

  it('asks the existing library admin to sign in once', () => {
    render(FirstRunSetup, { initial: createSetup('existing'), authenticated: false });
    expect(screen.getByRole('heading', { name: 'Sign in to finish setting up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in and continue' })).toBeInTheDocument();
  });

  it('says when Frameleaf Cloud is not reachable and offers a local account', async () => {
    // Sign-in is offered, but the hand-over to Frameleaf fails: setup says so and falls back.
    sdkMock.getPublicConfig.mockResolvedValue({ frameleaf: { signInAvailable: true } } as never);
    sdkMock.startFrameleafSignIn.mockRejectedValue(new Error('unreachable'));
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    render(FirstRunSetup, { initial: { ...state, step: account, reached: account }, authenticated: false });
    const signIn = await screen.findByRole('button', { name: /Sign in with Frameleaf/ });
    await waitFor(() => expect(signIn).toBeEnabled());
    await fireEvent.click(signIn);
    expect(await screen.findByText("Frameleaf Cloud isn't reachable yet")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Use a local account instead' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Create the admin account' })).toBeInTheDocument());
  });

  it('offers a way out to a signed-in admin, but not at the sign-in gate', () => {
    const state = createSetup('existing');
    const { unmount } = render(FirstRunSetup, { initial: { ...state, step: 2, reached: 2 }, authenticated: true });
    expect(screen.getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', '/auth/logout');
    unmount();
    render(FirstRunSetup, { initial: state, authenticated: false });
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });

  describe('how you will sign in (N3)', () => {
    const choiceStep = () => {
      const state = createSetup('new');
      const step = flowSteps('new').findIndex((entry) => entry.id === 'sign-in-choice');
      return { ...state, step, reached: step };
    };
    const card = (name: string) => screen.getByText(name).closest('label')!;

    it('defaults to a local account and says why when Sign in with Frameleaf is unavailable', async () => {
      sdkMock.getPublicConfig.mockResolvedValue({ frameleaf: { signInAvailable: false } } as never);
      render(FirstRunSetup, { initial: choiceStep(), authenticated: false });
      expect(await screen.findByText(/Unavailable on this server for now/)).toBeInTheDocument();
      await waitFor(() => expect(within(card('Local account only')).getByRole('radio')).toBeChecked());
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeDisabled();
      expect(within(card('Frameleaf account')).queryByText('Recommended')).toBeNull();
      expect(within(card('Local account only')).getByText('Recommended')).toBeInTheDocument();
    });

    it('keeps Frameleaf recommended and chosen when sign-in is available', async () => {
      sdkMock.getPublicConfig.mockResolvedValue({ frameleaf: { signInAvailable: true } } as never);
      render(FirstRunSetup, { initial: choiceStep(), authenticated: false });
      await waitFor(() => expect(sdkMock.getPublicConfig).toHaveBeenCalled());
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeChecked();
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeEnabled();
      expect(within(card('Frameleaf account')).getByText('Recommended')).toBeInTheDocument();
      expect(screen.queryByText(/Unavailable on this server for now/)).toBeNull();
    });
  });
});
