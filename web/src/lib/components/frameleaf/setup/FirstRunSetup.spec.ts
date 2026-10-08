import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
import { createSetup, flowSteps } from '$lib/frameleaf/first-run-setup';
import { handleSystemConfigSave } from '$lib/services/system-config.service';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/services/system-config.service', () => ({ handleSystemConfigSave: vi.fn() }));

/** The server config's Frameleaf block, as `GET server/config` answers it before anyone signs in. */
const serverConfig = (frameleaf: { cloudConfigured: boolean; signInAvailable: boolean }) =>
  ({ frameleaf: { via: null, signInRequired: false, publicUrl: null, ...frameleaf } }) as never;

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
    const root = container.querySelector<HTMLElement>('section.frs-root');
    expect(root?.dataset.theme).toBe('dark');
    // the one hero line, with the brand rule under it; the kit's own lockup arrives with Unfurl
    const hero = screen.getByRole('heading', { level: 1, name: 'Your photos, beautifully kept. On your own server.' });
    expect(hero).toHaveClass('fl-type-hero');
    expect(container.querySelector(':scope .frs-logo .fl-brand-line')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector(':scope .frs-logo img.fl-logo-arrive')).toHaveAttribute('alt', 'Frameleaf');
    expect(container.querySelector('.frs-logo-stroke, .frs-logo-glow')).toBeNull();
    // Continue is live once the short arrival has settled
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue setup/ })).not.toHaveAttribute('inert'));
    await fireEvent.click(screen.getByRole('button', { name: /Continue setup/ }));
    expect(await screen.findByRole('heading', { name: "How you'll sign in" })).toBeInTheDocument();
    expect(screen.getByText('Frameleaf account')).toBeInTheDocument();
    expect(screen.getByText('Local account only')).toBeInTheDocument();
    expect(root?.dataset.theme).toBe('dark');
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

  it('submits the admin form on Enter, asks for the setup code first and focuses the first problem', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    const { container } = render(FirstRunSetup, {
      initial: { ...state, step: account, reached: account, choices: { ...state.choices, signIn: 'local' } },
      authenticated: false,
    });
    const form = container.querySelector<HTMLFormElement>('form#frs-account-form')!;
    const fields = [...form.querySelectorAll('input')].map((input) => input.id);
    expect(fields[0]).toBe('frs-setup-code');
    // Continue is the form's own submit button, so Enter and the button take the same path
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveAttribute('form', 'frs-account-form');
    await fireEvent.submit(form);
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    // one announcement for the whole form; each message is tied to its field
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-describedby', 'frs-name-error');
    await waitFor(() => expect(screen.getByLabelText('Setup code')).toHaveFocus());
    expect(sdkMock.signUpAdmin).not.toHaveBeenCalled();
  });

  it('does not call a library healthy when the check has no data, and links nowhere during setup', async () => {
    sdkMock.getFrameleafSetupLibrary.mockResolvedValue({ items: 1200, people: 4, albums: 9, bytes: 5e11 } as never);
    sdkMock.getSummary.mockRejectedValue(new Error('unavailable'));
    const state = createSetup('existing');
    const check = flowSteps('existing').findIndex((entry) => entry.id === 'library-check');
    render(FirstRunSetup, { initial: { ...state, step: check, reached: check }, authenticated: true });
    expect(await screen.findByText('We could not check the file records just now')).toBeInTheDocument();
    expect(screen.queryByText(/look healthy/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Library Care/ })).toBeNull();
  });

  it('asks the existing library admin to sign in once', () => {
    render(FirstRunSetup, { initial: createSetup('existing'), authenticated: false });
    expect(screen.getByRole('heading', { name: 'Sign in to finish setting up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in and continue' })).toBeInTheDocument();
  });

  it('says when Frameleaf Cloud is not reachable and offers a local account', async () => {
    // A server already linked (a headless link token): Sign in with Frameleaf is offered, but the
    // hand-over to Frameleaf fails, so setup says so and falls back.
    sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: true, signInAvailable: true }));
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

  describe('linking to Frameleaf Cloud is the featured path (FL-168)', () => {
    const accountStep = (choices: Partial<ReturnType<typeof createSetup>['choices']> = {}) => {
      const state = createSetup('new');
      const step = flowSteps('new').findIndex((entry) => entry.id === 'account');
      return { ...state, step, reached: step, choices: { ...state.choices, ...choices } };
    };

    it('on a server not linked yet, creates the administrator first and contacts nothing', async () => {
      sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: true, signInAvailable: false }));
      render(FirstRunSetup, { initial: accountStep(), authenticated: false });
      await waitFor(() => expect(sdkMock.getServerConfig).toHaveBeenCalled());
      expect(await screen.findByRole('heading', { name: 'Create the admin account' })).toBeInTheDocument();
      expect(screen.getByText(/Nothing is sent to Frameleaf until you start linking/)).toBeInTheDocument();
      expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
      expect(sdkMock.startFrameleafSignIn).not.toHaveBeenCalled();
    });

    it('then links only when asked, and offers to continue with a local account', async () => {
      sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: true, signInAvailable: false }));
      sdkMock.getCloudStatus.mockResolvedValue({ state: 'unlinked', configured: true, pending: null } as never);
      sdkMock.getLicenseStatus.mockResolvedValue({} as never);
      sdkMock.getLicenseProducts.mockResolvedValue({} as never);
      sdkMock.startCloudLink.mockResolvedValue({
        state: 'pending',
        configured: true,
        pending: {
          userCode: 'BCDF-GHJK',
          verificationUri: 'https://id.frameleaf.test/device',
          verificationUriComplete: 'https://id.frameleaf.test/device?code=BCDF-GHJK',
          expiresAt: '2026-09-27T12:00:00.000Z',
          intervalSeconds: 5,
        },
      } as never);
      render(FirstRunSetup, {
        initial: accountStep({ accountCreated: true, adminEmail: 'ada@example.com' }),
        authenticated: true,
      });
      expect(await screen.findByRole('heading', { name: 'Link to Frameleaf' })).toBeInTheDocument();
      expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
      const start = await screen.findByRole('button', { name: /Sign in with Frameleaf/ });
      await waitFor(() => expect(start).toBeEnabled());
      await fireEvent.click(start);
      await waitFor(() => expect(sdkMock.startCloudLink).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('BCDF-GHJK')).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'Continue with local account' }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Create the admin account' })).toBeInTheDocument(),
      );
      expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
    });

    it('records the linked-server tour as covered by setup when the link lands (FL-196)', async () => {
      sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: true, signInAvailable: false }));
      sdkMock.getCloudStatus.mockResolvedValue({
        state: 'linked',
        configured: true,
        pending: null,
        account: { id: 'account-1', label: 'ada@example.com' },
      } as never);
      sdkMock.getLicenseStatus.mockResolvedValue({} as never);
      sdkMock.getLicenseProducts.mockResolvedValue({} as never);
      sdkMock.markCloudTourSeen.mockResolvedValue({} as never);
      sdkMock.updateFrameleafSetup.mockResolvedValue({} as never);
      render(FirstRunSetup, {
        initial: accountStep({ accountCreated: true, adminEmail: 'ada@example.com' }),
        authenticated: true,
      });
      await waitFor(() =>
        expect(sdkMock.markCloudTourSeen).toHaveBeenCalledWith({ cloudTourSeenDto: { ending: 'setup' } }),
      );
    });
  });

  it('stops Open Frameleaf when the choices are not saved, says so in place and tries again', async () => {
    const config = {
      storageTemplate: { enabled: false, template: '' },
      machineLearning: { clip: { modelName: 'model' } },
      backup: { database: { enabled: true } },
      newVersionCheck: { enabled: false },
      map: { enabled: true },
    };
    sdkMock.getConfig.mockResolvedValue(config as never);
    vi.mocked(handleSystemConfigSave).mockResolvedValueOnce(false);
    const state = createSetup('existing');
    const last = flowSteps('existing').length - 1;
    render(FirstRunSetup, {
      initial: { ...state, step: last, reached: last, choices: { ...state.choices, signedIn: true } },
      authenticated: true,
    });
    await fireEvent.click(screen.getByRole('button', { name: /Open Frameleaf/ }));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent(en.frameleaf_setup_finish_save_failed);
    // setup said it itself: no "Settings saved" toast, and nothing after the save ran
    expect(handleSystemConfigSave).toHaveBeenCalledWith(expect.anything(), { notifySaved: false });
    expect(sdkMock.finishFrameleafSetup).not.toHaveBeenCalled();
    expect(sdkMock.setUserOnboarding).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Open Frameleaf/ })).toBeEnabled();

    vi.mocked(handleSystemConfigSave).mockResolvedValueOnce(true);
    await fireEvent.click(within(failure).getByRole('button', { name: en.frameleaf_error_retry }));
    await waitFor(() => expect(sdkMock.finishFrameleafSetup).toHaveBeenCalledOnce());
    expect(screen.queryByText(en.frameleaf_setup_finish_save_failed)).toBeNull();
  });

  it('draws the chapter line on to the next chapter once the server is linked', () => {
    const state = createSetup('existing');
    const account = flowSteps('existing').findIndex((entry) => entry.id === 'account');
    const at = (linked: boolean) => {
      const { container, unmount } = render(FirstRunSetup, {
        initial: { ...state, step: account, reached: account, choices: { ...state.choices, signedIn: true, linked } },
        authenticated: true,
      });
      const rail = container.querySelector<HTMLElement>('.frs-rail ol')!;
      const result = { progress: rail.style.getPropertyValue('--frs-progress'), drawn: 'drawn' in rail.dataset };
      unmount();
      return result;
    };
    // five chapters: Account is the second, and the line reaches the third once linked
    expect(at(false)).toEqual({ progress: '0.25', drawn: false });
    expect(at(true)).toEqual({ progress: '0.5', drawn: true });
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

    it('defaults to a local account and says why when Frameleaf Cloud is not set up here', async () => {
      sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: false, signInAvailable: false }));
      render(FirstRunSetup, { initial: choiceStep(), authenticated: false });
      expect(await screen.findByText(/Not set up on this server/)).toBeInTheDocument();
      await waitFor(() => expect(within(card('Local account only')).getByRole('radio')).toBeChecked());
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeDisabled();
      expect(within(card('Frameleaf account')).queryByText('Recommended')).toBeNull();
      expect(within(card('Local account only')).getByText('Recommended')).toBeInTheDocument();
    });

    it('keeps Frameleaf recommended and chosen wherever Frameleaf Cloud is set up, linked or not (FL-168)', async () => {
      sdkMock.getServerConfig.mockResolvedValue(serverConfig({ cloudConfigured: true, signInAvailable: false }));
      render(FirstRunSetup, { initial: choiceStep(), authenticated: false });
      await waitFor(() => expect(sdkMock.getServerConfig).toHaveBeenCalled());
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeChecked();
      expect(within(card('Frameleaf account')).getByRole('radio')).toBeEnabled();
      expect(within(card('Frameleaf account')).getByText('Recommended')).toBeInTheDocument();
      expect(screen.queryByText(/Not set up on this server/)).toBeNull();
      // choosing is not linking: nothing is contacted from this step
      expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
    });
  });
});
