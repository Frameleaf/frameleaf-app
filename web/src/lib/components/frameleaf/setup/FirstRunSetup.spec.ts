import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
import { createSetup, flowSteps } from '$lib/frameleaf/first-run-setup';
import { cloudManager } from '$lib/managers/cloud-manager.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

/**
 * FL-647: setup reads the server config the root layout already loaded (`serverConfigManager`)
 * instead of requesting it again. Each test sets what that load returned; unset, the manager is
 * not initialized and reading it throws, as it does before the root layout ran.
 */
const serverConfigState = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: {
    get value() {
      if (!serverConfigState.value) {
        throw new Error('Server config manager must be initialized first');
      }
      return serverConfigState.value;
    },
    init: vi.fn(),
    loadServerConfig: vi.fn(),
  },
}));

const setServerConfig = (config: unknown) => {
  serverConfigState.value = config;
};

describe('FirstRunSetup (FL-176)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setServerConfig(undefined);
  });

  it('runs on the dark stage and opens with the logo intro', async () => {
    const { container } = render(FirstRunSetup, { initial: createSetup('new'), authenticated: false });
    const root = container.querySelector<HTMLElement>('section.frs-root');
    expect(root?.dataset.theme).toBe('dark');
    // the one hero line; the kit's own lockup fades in
    const hero = screen.getByRole('heading', { level: 1, name: 'Your photos, beautifully kept. On your own server.' });
    expect(hero).toHaveClass('fl-type-hero');
    expect(container.querySelector(':scope .frs-logo img.fl-logo-arrive')).toHaveAttribute('alt', 'Frameleaf');
    expect(container.querySelector('.frs-logo-stroke, .frs-logo-glow')).toBeNull();
    // Continue is live once the short arrival has settled
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue setup/ })).not.toHaveAttribute('inert'));
    // Item 1: the one welcome also offers "Restore from a backup" (it had its own page before)
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Continue setup/ }));
    // FL-708 item 20: no "How you'll sign in" choice; the local administrator comes first
    expect(await screen.findByRole('heading', { name: 'Create your admin account' })).toBeInTheDocument();
    expect(screen.queryByText("How you'll sign in")).toBeNull();
    expect(root?.dataset.theme).toBe('dark');
    // the chapter rail marks Welcome done and Account current; the counter counts its chapters (item 2)
    expect(screen.getByRole('button', { name: /Account/, current: 'step' })).toBeInTheDocument();
    expect(screen.getByText('Account · 2 of 5')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('keeps the admin on the account step until it is complete, without saving the password', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    render(FirstRunSetup, {
      initial: { ...state, step: account, reached: account },
      authenticated: false,
    });
    expect(screen.getByRole('heading', { name: 'Create your admin account' })).toBeInTheDocument();
    // item 19: one rule (length), then a hint; no character-class rules
    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.queryByText('An uppercase letter')).toBeNull();
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-9' } });
    await fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(sdkMock.signUpAdmin).not.toHaveBeenCalled();
    expect(localStorage.getItem('frameleaf:setup:v1')).not.toContain('Correct-Horse-9');
  });

  it('keeps focus in the admin form while typing', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    render(FirstRunSetup, {
      initial: { ...state, step: account, reached: account },
      authenticated: false,
    });
    const name = screen.getByLabelText('Name');
    name.focus();
    await fireEvent.input(name, { target: { value: 'A' } });
    await fireEvent.input(name, { target: { value: 'Al' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Al');
  });

  it('submits the admin form on Enter, starts with the name and focuses the first problem', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    const { container } = render(FirstRunSetup, {
      initial: { ...state, step: account, reached: account },
      authenticated: false,
    });
    const form = container.querySelector<HTMLFormElement>('form#frs-account-form')!;
    const fields = [...form.querySelectorAll('input')].map((input) => input.id);
    expect(fields).not.toContain('frs-setup-code');
    expect(fields[0]).toBe('frs-name');
    // Continue is the form's own submit button, so Enter and the button take the same path
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveAttribute('form', 'frs-account-form');
    await fireEvent.submit(form);
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    // one announcement for the whole form; each message is tied to its field
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-describedby', 'frs-name-error');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
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

  it('shows the library location check without waiting for the hardware benchmark, in the unit that fits', async () => {
    sdkMock.getHardwareCheck.mockReturnValue(new Promise(() => {}) as never);
    sdkMock.getFrameleafSetupStorage.mockResolvedValue({
      path: '/library',
      writable: true,
      freeBytes: 18_644_967_424,
      totalBytes: 270_553_174_016,
    } as never);
    const state = createSetup('new');
    const library = flowSteps('new').findIndex((entry) => entry.id === 'library');
    const { container } = render(FirstRunSetup, {
      initial: { ...state, step: library, reached: library },
      authenticated: true,
    });
    expect(await screen.findByText('Writable, 19 GB free')).toBeInTheDocument();
    expect(screen.queryByText(/0\.0 TB/)).toBeNull();
    // item 4: the location is read-only text, not a field, and the step carries no "Required"
    expect(container.querySelector(':scope .frs-location code')).toHaveTextContent('/library');
    expect(container.querySelector('#frs-storage')).toBeNull();
    expect(screen.queryByText('Required')).toBeNull();
  });

  it('always says Continue, and sums up the library and privacy in words (items 3 and 5)', async () => {
    sdkMock.getHardwareCheck.mockReturnValue(new Promise(() => {}) as never);
    sdkMock.getFrameleafSetupStorage.mockResolvedValue({
      path: '/library',
      writable: true,
      freeBytes: 65_000_000_000,
      totalBytes: 270_553_174_016,
    } as never);
    const state = createSetup('new');
    const ready = flowSteps('new').findIndex((entry) => entry.id === 'ready');
    const privacy = flowSteps('new').findIndex((entry) => entry.id === 'privacy');
    const created = { ...state.choices, accountCreated: true, map: false };
    const { unmount } = render(FirstRunSetup, {
      initial: { ...state, step: privacy, reached: privacy, choices: created },
      authenticated: true,
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByText('Use recommended')).toBeNull();
    unmount();
    render(FirstRunSetup, {
      initial: { ...state, step: ready, reached: ready, choices: created },
      authenticated: true,
    });
    expect(await screen.findByText('65 GB free · Year / Month')).toBeInTheDocument();
    expect(screen.getByText('Update checks on · Map tiles off')).toBeInTheDocument();
    expect(screen.queryByText(/\{\{|library\/admin/)).toBeNull();
  });

  describe('the welcome figures after an Immich import', () => {
    const welcome = () => {
      const state = createSetup('existing');
      const step = flowSteps('existing').findIndex((entry) => entry.id === 'welcome');
      return { ...state, step, reached: step };
    };
    const imported = { items: 80, people: 0, albums: 4, bytes: 306e6 } as never;
    // what is on screen: a counting figure's visible digits, or the plain figure
    const shown = (container: HTMLElement) =>
      [...container.querySelectorAll(':scope .frs-stats strong')].map(
        (figure) => (figure.querySelector(':scope [aria-hidden="true"]') ?? figure).textContent,
      );

    beforeEach(() => {
      // Right after an import the hardware check (a live benchmark) and the Library Care summary
      // take seconds; the welcome figures must not wait for them.
      sdkMock.getHardwareCheck.mockReturnValue(new Promise(() => {}) as never);
      sdkMock.getSummary.mockReturnValue(new Promise(() => {}) as never);
      sdkMock.updateFrameleafSetup.mockResolvedValue({} as never);
    });

    it('shows the real totals while slower checks are still out', async () => {
      sdkMock.getFrameleafSetupLibrary.mockResolvedValue(imported);
      const { container } = render(FirstRunSetup, { initial: welcome(), authenticated: true });
      await waitFor(() => expect(shown(container)).toEqual(['80', '0', '4', '306 MB']));
    });

    it('shows totals that land after the intro at once, never counting up from 0', async () => {
      let land!: (value: never) => void;
      sdkMock.getFrameleafSetupLibrary.mockReturnValue(new Promise((resolve) => (land = resolve)) as never);
      const { container } = render(FirstRunSetup, { initial: welcome(), authenticated: true });
      await waitFor(() => expect(screen.getByRole('button', { name: /Continue setup/ })).not.toHaveAttribute('inert'));
      land(imported);
      // one macrotask: the request settles and redraws, before any count-up frame could run
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
      expect(shown(container)).toEqual(['80', '0', '4', '306 MB']);
    });
  });

  it('asks the existing library admin to sign in once', () => {
    render(FirstRunSetup, { initial: createSetup('existing'), authenticated: false });
    expect(screen.getByRole('heading', { name: 'Sign in to finish setting up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in and continue' })).toBeInTheDocument();
  });

  describe('Add a Frameleaf account (FL-708 item 20)', () => {
    const accountStep = (choices: Partial<ReturnType<typeof createSetup>['choices']> = {}) => {
      const state = createSetup('new');
      const step = flowSteps('new').findIndex((entry) => entry.id === 'frameleaf-account');
      return {
        ...state,
        step,
        reached: step,
        choices: {
          ...state.choices,
          accountCreated: true,
          adminName: 'Ada',
          adminEmail: 'ada@example.com',
          ...choices,
        },
      };
    };
    const cloud = (status: object) => {
      sdkMock.getCloudStatus.mockResolvedValue({ configured: true, pending: null, ...status } as never);
      sdkMock.getLicenseStatus.mockResolvedValue({} as never);
      sdkMock.getLicenseProducts.mockResolvedValue({} as never);
      sdkMock.updateFrameleafSetup.mockResolvedValue({} as never);
    };
    /** The cloud manager is shared: load this test's status before rendering, not an earlier test's link. */
    const cloudNow = async (status: object) => {
      cloud(status);
      await cloudManager.refresh();
    };
    const consents = {
      tos: { version: '2026-10-01.1', text: 'I agree to the Frameleaf Terms of Use.' },
      privacy: { version: '2026-10-01.2', text: 'I have read the Frameleaf privacy notice.' },
    };
    const linkedStatus = {
      state: 'linked',
      configured: true,
      pending: null,
      account: { id: 'account-1', label: 'Ada' },
    };
    const answer = (outcome: string, extra: object = {}) => ({
      outcome,
      challenge: null,
      refusal: null,
      message: null,
      attemptsLeft: null,
      retryAfterSeconds: null,
      status: { state: 'unlinked', configured: true, pending: null },
      ...extra,
    });

    it('fills the name and email from the admin, sends them with the password, and links after the emailed code', async () => {
      cloud({ state: 'unlinked' });
      sdkMock.getCloudAccountLinkConsents.mockResolvedValue(consents as never);
      sdkMock.linkCloudWithAccount.mockResolvedValue(
        answer('code-needed', {
          challenge: { challengeId: 'challenge-1', kind: 'email-code', expiresAt: '2026-10-31T12:10:00.000Z' },
        }) as never,
      );
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      expect(await screen.findByRole('heading', { name: 'Add a Frameleaf account' })).toBeInTheDocument();
      expect(screen.getByText('Account · 2 of 5')).toBeInTheDocument();
      expect(screen.queryByText('Required')).toBeNull();
      expect(screen.getByLabelText('Name')).toHaveValue('Ada');
      expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
      expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', 'https://frameleaf.app/legal');
      // FC-222: the statements Frameleaf Cloud records as shown
      expect(await screen.findByText('I agree to the Frameleaf Terms of Use.')).toBeInTheDocument();
      expect(screen.getByText('I have read the Frameleaf privacy notice.')).toBeInTheDocument();
      // "Skip for now" sits where Continue does
      expect(screen.getByRole('button', { name: /Skip for now/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();

      const create = screen.getByRole('button', { name: 'Create account and link' });
      await fireEvent.input(screen.getByLabelText('Frameleaf password'), { target: { value: 'sevench' } });
      await fireEvent.click(create);
      expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
      expect(sdkMock.linkCloudWithAccount).not.toHaveBeenCalled();

      await fireEvent.input(screen.getByLabelText('Frameleaf password'), { target: { value: 'a long passphrase' } });
      await fireEvent.click(create);
      await waitFor(() =>
        expect(sdkMock.linkCloudWithAccount).toHaveBeenCalledWith({
          cloudAccountLinkDto: {
            mode: 'create',
            email: 'ada@example.com',
            password: 'a long passphrase',
            name: 'Ada',
            consent: { tos: '2026-10-01.1', privacy: '2026-10-01.2' },
          },
        }),
      );
      // no approval code: the emailed code links it
      expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
      expect(screen.getByText(/Enter the 6-digit code Frameleaf sent to ada@example.com/)).toBeInTheDocument();
      expect(localStorage.getItem('frameleaf:setup:v1')).not.toContain('a long passphrase');

      sdkMock.verifyCloudAccountLink.mockResolvedValueOnce(
        answer('refused', { refusal: 'code-invalid', attemptsLeft: 4 }) as never,
      );
      await fireEvent.input(screen.getByLabelText('Code'), { target: { value: '000000' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Verify and link' }));
      expect(await screen.findByText("That code isn't right. 4 tries left.")).toBeInTheDocument();

      sdkMock.verifyCloudAccountLink.mockImplementationOnce(() => {
        sdkMock.getCloudStatus.mockResolvedValue(linkedStatus as never);
        return Promise.resolve(answer('linked', { status: linkedStatus }) as never);
      });
      await fireEvent.input(screen.getByLabelText('Code'), { target: { value: '123456' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Verify and link' }));
      await waitFor(() =>
        expect(sdkMock.verifyCloudAccountLink).toHaveBeenLastCalledWith({
          cloudAccountLinkVerifyDto: { challengeId: 'challenge-1', code: '123456' },
        }),
      );
      expect(await screen.findByRole('heading', { name: 'Your Frameleaf account' })).toBeInTheDocument();
    });

    it('signs in to an existing account and says plainly why it did not link', async () => {
      await cloudNow({ state: 'unlinked' });
      sdkMock.getCloudAccountLinkConsents.mockResolvedValue(consents as never);
      sdkMock.linkCloudWithAccount.mockResolvedValue(answer('refused', { refusal: 'invalid-credentials' }) as never);
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      await fireEvent.click(await screen.findByRole('button', { name: 'I already have a Frameleaf account' }));
      await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'x' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Sign in and link' }));
      await waitFor(() =>
        expect(sdkMock.linkCloudWithAccount).toHaveBeenCalledWith({
          cloudAccountLinkDto: { mode: 'sign-in', email: 'ada@example.com', password: 'x' },
        }),
      );
      expect(await screen.findByText(/That email and password don't match a Frameleaf account/)).toBeInTheDocument();
      // the password is cleared after it was sent
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });

    it('offers, never assumes, linking in the region the account keeps its data in (FC-18)', async () => {
      await cloudNow({ state: 'unlinked' });
      sdkMock.getCloudAccountLinkConsents.mockResolvedValue(consents as never);
      sdkMock.linkCloudWithAccount.mockResolvedValueOnce(
        answer('refused', { refusal: 'region-mismatch', accountRegion: 'eu' }) as never,
      );
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      await fireEvent.click(await screen.findByRole('button', { name: 'I already have a Frameleaf account' }));
      await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'x' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Sign in and link' }));
      expect(await screen.findByText(/This account keeps its data in the EU/)).toBeInTheDocument();
      expect(sdkMock.linkCloudWithAccount).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Link in the EU' }));
      expect(screen.getByText(/cloud data will live in the EU/)).toBeInTheDocument();
      sdkMock.linkCloudWithAccount.mockResolvedValueOnce(answer('refused', { refusal: 'rate-limited' }) as never);
      await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'x' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Sign in and link' }));
      await waitFor(() =>
        expect(sdkMock.linkCloudWithAccount).toHaveBeenLastCalledWith({
          cloudAccountLinkDto: { mode: 'sign-in', email: 'ada@example.com', password: 'x', dataRegion: 'eu' },
        }),
      );
    });

    it('switches to signing in to an existing account', async () => {
      cloud({ state: 'unlinked' });
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      await fireEvent.click(await screen.findByRole('button', { name: 'I already have a Frameleaf account' }));
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
      expect(screen.getByRole('button', { name: 'Sign in and link' })).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Create a new account instead' }));
      expect(screen.getByRole('button', { name: 'Create account and link' })).toBeInTheDocument();
    });

    it('can be skipped, and moves on to the library', async () => {
      cloud({ state: 'unlinked' });
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      await fireEvent.click(await screen.findByRole('button', { name: /Skip for now/ }));
      expect(await screen.findByRole('heading', { name: 'Where your library lives' })).toBeInTheDocument();
      expect(sdkMock.linkCloudWithAccount).not.toHaveBeenCalled();
    });

    it('says when Frameleaf Cloud is not set up here, and can still be skipped', async () => {
      cloud({ state: 'not-configured', configured: false });
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      expect(await screen.findByText("Frameleaf Cloud isn't reachable yet")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Skip for now/ })).toBeInTheDocument();
    });

    it('records the linked-server tour as covered by setup when the link lands (FL-196)', async () => {
      cloud({ state: 'linked', account: { id: 'account-1', label: 'ada@example.com' } });
      sdkMock.markCloudTourSeen.mockResolvedValue({} as never);
      render(FirstRunSetup, { initial: accountStep(), authenticated: true });
      await waitFor(() =>
        expect(sdkMock.markCloudTourSeen).toHaveBeenCalledWith({ cloudTourSeenDto: { ending: 'setup' } }),
      );
      expect(await screen.findByRole('heading', { name: 'Your Frameleaf account' })).toBeInTheDocument();
      expect(
        screen.getByText(/Sign in here with your admin password\. To offer Sign in with Frameleaf at home too/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Continue/ })).toBeInTheDocument();
    });
  });

  it('offers a way out to a signed-in admin, but not at the sign-in gate', () => {
    const state = createSetup('existing');
    const { unmount } = render(FirstRunSetup, { initial: { ...state, step: 2, reached: 2 }, authenticated: true });
    expect(screen.getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', '/auth/logout');
    unmount();
    render(FirstRunSetup, { initial: state, authenticated: false });
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });
});
