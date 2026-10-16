import {
  completeMailSignIn,
  disconnectMailAccount,
  getMailConnection,
  MailConnectionStatus,
  MailSignInProvider,
  MailSignInState,
  MailSignInUnavailableReason,
  MailTransportType,
  sendTestEmailAdmin,
  startMailSignIn,
  type AdminConfigDto,
  type MailConnectionDto,
  type MailConnectionStateDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { SIGN_IN_POLL_MS } from '$lib/components/frameleaf/settings/notifications/mail-sign-in.svelte';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import NotificationSettings from './NotificationSettings.svelte';

/**
 * Notifications › Email delivery, signing in with Google or Microsoft (FL-379). Every state on the
 * page comes from what the server answers: `getMailConnection` for who is connected and whether
 * signing in is on offer, and the saved settings for how email is sent.
 */
const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const flags = vi.hoisted(() => ({ configFile: false, email: false }));

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getMailConnection: vi.fn(),
  startMailSignIn: vi.fn(),
  completeMailSignIn: vi.fn(),
  disconnectMailAccount: vi.fn(),
  sendTestEmailAdmin: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { email: 'taylor@example.com', isAdmin: true } },
}));
vi.mock(import('$lib/managers/system-config-manager.svelte'), () => ({
  systemConfigManager: { value: {} as AdminConfigDto } as never,
}));
vi.mock(import('$lib/managers/event-manager.svelte'), () => ({
  eventManager: { emit: vi.fn(), on: vi.fn() } as never,
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

type Transport = AdminConfigDto['notifications']['smtp']['transport'];
const config = (transport: Partial<Transport> = {}, enabled = false) =>
  ({
    notifications: {
      smtp: {
        enabled,
        from: '',
        replyTo: '',
        transport: {
          type: MailTransportType.Smtp,
          host: '',
          port: 587,
          secure: false,
          username: '',
          password: '',
          ignoreCert: false,
          ...transport,
        },
      },
    },
    templates: { email: { welcomeTemplate: '', albumInviteTemplate: '', albumUpdateTemplate: '' } },
  }) as unknown as AdminConfigDto;

const connected = (overrides: Partial<MailConnectionDto> = {}): MailConnectionDto => ({
  provider: MailSignInProvider.Gmail,
  email: 'rivera@gmail.com',
  status: MailConnectionStatus.Connected,
  connectedAt: '2026-10-11T10:00:00.000Z',
  ...overrides,
});

const answer = (overrides: Partial<MailConnectionStateDto> = {}): MailConnectionStateDto => ({
  available: true,
  providers: [MailSignInProvider.Gmail, MailSignInProvider.Microsoft],
  connection: null,
  signIn: MailSignInState.None,
  ...overrides,
});

const open = (saved: AdminConfigDto, state: MailConnectionStateDto) => {
  const load = vi.fn().mockResolvedValue({ config: saved, revision: 'r1' });
  const save = vi.fn();
  const store = new SystemConfigDraftStore({ config: saved, revision: 'r1' }, { defaults: config(), load, save });
  draft.store = store;
  vi.mocked(getMailConnection).mockResolvedValue(state);
  render(NotificationSettings);
  return { store, load, save };
};

/** Picks a provider tile; the Microsoft tile is there once the server has said what it offers. */
const pick = async (name: string) =>
  fireEvent.click(await within(tiles()).findByRole('button', { name: new RegExp(`^${name}`) }));
const tiles = () => screen.getByRole('group', { name: en.frameleaf_notify_delivery_which });
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_notify_hero_label }));
const button = (name: string) => screen.getByRole('button', { name });

describe('Email delivery: signing in with Google or Microsoft (FL-379)', () => {
  let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    flags.configFile = false;
    tab = { opener: globalThis, location: { href: '' }, close: vi.fn() };
    vi.spyOn(globalThis, 'open').mockReturnValue(tab as unknown as Window);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('not signed in', () => {
    it('offers Gmail and Microsoft among the providers, Microsoft with its hint', async () => {
      open(config(), answer());
      const names = await waitFor(() => {
        const found = within(tiles())
          .getAllByRole('button')
          .map((tile) => tile.querySelector('strong')?.textContent);
        expect(found).toContain('Microsoft');
        return found;
      });
      expect(names).toEqual(['Gmail', 'iCloud Mail', 'Microsoft', 'Yahoo Mail', 'Other']);
      expect(within(tiles()).getByText('Outlook.com, Hotmail and Microsoft 365')).toBeInTheDocument();
    });

    it('shows one row to sign in with Google, says what Frameleaf may do, and writes nothing to the draft', async () => {
      const { store } = open(config(), answer());
      await pick('Gmail');

      expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
      expect(
        screen.getByText(/Frameleaf can send and nothing else: it cannot read your mail\. No password is kept/),
      ).toBeInTheDocument();
      expect(button('Use an app password instead')).toBeInTheDocument();
      expect(store.dirty).toBe(false);
      // nothing to test or switch on until an account is signed in
      expect(screen.queryByRole('button', { name: en.frameleaf_notify_test_send })).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: en.frameleaf_notify_delivery_send })).not.toBeInTheDocument();
    });

    it('opens the provider’s page in a new tab, waits, and follows the saved settings once signed in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { load } = open(config(), answer());
      await pick('Gmail');
      vi.mocked(startMailSignIn).mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
        expiresAt: '2026-10-11T10:10:00.000Z',
      });
      vi.mocked(completeMailSignIn)
        .mockResolvedValueOnce({ state: MailSignInState.Pending, connection: null })
        .mockResolvedValueOnce({ state: MailSignInState.Connected, connection: connected() });

      await fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

      expect(startMailSignIn).toHaveBeenCalledWith({ mailSignInStartDto: { provider: MailSignInProvider.Gmail } });
      await waitFor(() => expect(tab.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=x'));
      expect(tab.opener).toBeNull();
      expect(await screen.findByText('Waiting for you on the Google page')).toBeInTheDocument();
      expect(button('Open the Google page again')).toBeInTheDocument();

      // the server connected the account and pointed email at it
      vi.mocked(getMailConnection).mockResolvedValue(answer({ connection: connected() }));
      load.mockResolvedValue({ config: config({ type: MailTransportType.Gmail }, true), revision: 'r2' });
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS);
      expect(completeMailSignIn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS);

      expect(await screen.findByText('Signed in as')).toBeInTheDocument();
      expect(screen.getByText('Signed in with Google. Frameleaf now sends from rivera@gmail.com.')).toBeInTheDocument();
      expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_on })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS * 2);
      expect(completeMailSignIn).toHaveBeenCalledTimes(2);
    });

    it.each([
      [MailSignInState.Denied, en.frameleaf_notify_signin_denied],
      [MailSignInState.Expired, en.frameleaf_notify_signin_expired],
    ])('says how a sign-in that ended %s went, and offers it again', async (state, title) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      open(config(), answer());
      await pick('Gmail');
      vi.mocked(startMailSignIn).mockResolvedValue({ authorizationUrl: 'https://x.example', expiresAt: '' });
      vi.mocked(completeMailSignIn).mockResolvedValue({ state, connection: null });
      await fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS);

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(button('Sign in with Google')).toBeEnabled();
    });

    it('says why when the server refuses to start, and closes the tab it opened', async () => {
      open(config(), answer());
      await pick('Gmail');
      vi.mocked(startMailSignIn).mockRejectedValue({
        name: 'HttpError',
        status: 400,
        data: { message: 'Frameleaf Cloud does not offer signing in with Gmail yet' },
      });
      await fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

      expect(await screen.findByText(en.frameleaf_notify_signin_failed)).toBeInTheDocument();
      expect(tab.close).toHaveBeenCalled();
    });

    it('keeps Gmail’s app password route, and the way back to signing in', async () => {
      const { store } = open(config(), answer());
      await pick('Gmail');
      await fireEvent.click(await screen.findByRole('button', { name: 'Use an app password instead' }));

      expect(store.draft.notifications.smtp.transport).toMatchObject({
        type: MailTransportType.Smtp,
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
      });
      expect(screen.getByRole('textbox', { name: en.frameleaf_notify_delivery_address })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();

      await fireEvent.click(button('Sign in with Google instead'));
      expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
      expect(store.dirty).toBe(false);
    });

    it('opens a Gmail account saved with an app password on its form', async () => {
      open(config({ host: 'smtp.gmail.com', port: 465, secure: true, username: 'rivera@gmail.com' }, true), answer());
      expect(await screen.findByRole('button', { name: 'Sign in with Google instead' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: en.frameleaf_notify_delivery_address })).toHaveValue(
        'rivera@gmail.com',
      );
    });

    it('offers Microsoft by sign-in only, with no app password', async () => {
      const { store } = open(config(), answer());
      await pick('Microsoft');
      expect(await screen.findByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Use an app password instead' })).not.toBeInTheDocument();
      expect(store.dirty).toBe(false);
    });
  });

  describe('signed in', () => {
    const signedIn = (connection = connected()) =>
      open(config({ type: connection.provider as unknown as MailTransportType }, true), answer({ connection }));

    it('shows the connected address, how email is sent, and no mail server fields', async () => {
      signedIn();
      const row = (await screen.findByText('Signed in as')).closest('.kit-row') as HTMLElement;
      expect(within(row).getByText('rivera@gmail.com')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Disconnect…' })).toBeEnabled();
      expect(hero().getByText(/Frameleaf sends from rivera@gmail\.com\./)).toBeInTheDocument();

      expect(screen.getByText('Through Google’s own service')).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: en.frameleaf_notify_delivery_ignore_cert })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: en.frameleaf_notify_delivery_host })).not.toBeInTheDocument();
      expect(screen.queryByText(en.frameleaf_credentials_smtp_password)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Use an app password instead' })).not.toBeInTheDocument();
    });

    it('sends the test through the account and saves nothing', async () => {
      const { save } = signedIn();
      vi.mocked(sendTestEmailAdmin).mockResolvedValue({ messageId: 'm1' });
      await screen.findByText('Signed in as');
      expect(screen.getByText(en.frameleaf_notify_signin_test_description)).toBeInTheDocument();

      await fireEvent.click(button(en.frameleaf_notify_test_send));

      expect(await screen.findByText(/^Sent to taylor@example\.com at /)).toBeInTheDocument();
      expect(vi.mocked(sendTestEmailAdmin).mock.calls[0][0].adminConfigSmtpDto.transport).toMatchObject({
        type: MailTransportType.Gmail,
        password: '',
      });
      expect(save).not.toHaveBeenCalled();
    });

    it('shows the server’s reason when the test fails, without the password advice', async () => {
      signedIn();
      vi.mocked(sendTestEmailAdmin).mockRejectedValue({
        name: 'HttpError',
        status: 400,
        data: { message: 'Gmail refused (403): Daily sending limit reached' },
      });
      await screen.findByText('Signed in as');
      await fireEvent.click(button(en.frameleaf_notify_test_send));

      expect(await screen.findByText(en.frameleaf_notify_test_failed)).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(en.frameleaf_notify_test_failed_body))).not.toBeInTheDocument();
      // a refused renewal is found by sending, so the connection is read again
      await waitFor(() => expect(getMailConnection).toHaveBeenCalledTimes(2));
    });

    it('disconnects only after confirming, and says nothing is sent until an account is set up again', async () => {
      const { load } = signedIn();
      vi.mocked(confirmFrameleaf).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      vi.mocked(disconnectMailAccount).mockResolvedValue({ provider: MailSignInProvider.Gmail, revoked: true });
      const disconnect = await screen.findByRole('button', { name: 'Disconnect…' });

      await fireEvent.click(disconnect);
      await waitFor(() => expect(confirmFrameleaf).toHaveBeenCalledTimes(1));
      expect(vi.mocked(confirmFrameleaf).mock.calls[0][0]).toMatchObject({
        title: 'Disconnect rivera@gmail.com?',
        confirmText: 'Disconnect',
      });
      expect(vi.mocked(confirmFrameleaf).mock.calls[0][0].prompt).toContain(
        'Nothing is sent by email until an account is set up again.',
      );
      expect(disconnectMailAccount).not.toHaveBeenCalled();

      vi.mocked(getMailConnection).mockResolvedValue(answer());
      load.mockResolvedValue({ config: config(), revision: 'r2' });
      await fireEvent.click(disconnect);

      expect(
        await screen.findByText('Disconnected from Google. Nothing is sent by email until an account is set up again.'),
      ).toBeInTheDocument();
      expect(disconnectMailAccount).toHaveBeenCalledTimes(1);
      expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_off })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    });

    it('says where to remove Frameleaf when Microsoft cannot do it on disconnect', async () => {
      const { load } = signedIn(connected({ provider: MailSignInProvider.Microsoft, email: 'rivera@outlook.com' }));
      vi.mocked(confirmFrameleaf).mockResolvedValue(true);
      vi.mocked(disconnectMailAccount).mockResolvedValue({ provider: MailSignInProvider.Microsoft, revoked: false });
      vi.mocked(getMailConnection).mockResolvedValue(answer());
      load.mockResolvedValue({ config: config(), revision: 'r2' });

      await fireEvent.click(await screen.findByRole('button', { name: 'Disconnect…' }));

      const link = await screen.findByRole('link', { name: 'Open Microsoft’s app permissions' });
      expect(link).toHaveAttribute('href', 'https://account.live.com/consent/Manage');
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  describe('needs sign-in again', () => {
    it('says email stopped, why, and offers to sign in again', async () => {
      open(
        config({ type: MailTransportType.Gmail }, true),
        answer({
          connection: connected({
            status: MailConnectionStatus.NeedsSignIn,
            needsSignInSince: '2026-10-10T18:02:00.000Z',
          }),
        }),
      );

      expect(await hero().findByRole('heading', { name: 'Email stopped working' })).toBeInTheDocument();
      expect(hero().getByText(/Google is asking you to sign in again\./)).toBeInTheDocument();
      expect(screen.getByText('Sign in with Google again')).toBeInTheDocument();
      expect(
        screen.getByText(
          /the account’s password changes or Frameleaf’s access is removed\. Emails since then were not sent/,
        ),
      ).toBeInTheDocument();
      expect(button('Sign in again')).toBeEnabled();
      // not an account that can be tested or disconnected until it is signed in again
      expect(screen.queryByText('Signed in as')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: en.frameleaf_notify_test_send })).not.toBeInTheDocument();
    });
  });

  describe('a server that is not linked', () => {
    const unlinked = (unavailableReason = MailSignInUnavailableReason.NotLinked) =>
      open(config(), answer({ available: false, unavailableReason, providers: [] }));

    it('says signing in needs a free Frameleaf account and where to link, and offers no sign-in', async () => {
      unlinked();
      await pick('Gmail');

      expect(await screen.findByText('Signing in with Google needs a Frameleaf account')).toBeInTheDocument();
      expect(screen.getByText(/The account is free and nothing is paid\./)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();

      await fireEvent.click(button('Link this server'));
      expect(goto).toHaveBeenCalledWith(expect.stringContaining('area=cloud'));
      expect(vi.mocked(goto).mock.calls[0][0]).toContain('cloud-account');
    });

    it('still lets Gmail be set up with an app password', async () => {
      unlinked();
      await pick('Gmail');
      await fireEvent.click(await screen.findByRole('button', { name: 'Use an app password instead' }));
      expect(screen.getByRole('textbox', { name: en.frameleaf_notify_delivery_address })).toBeInTheDocument();
    });

    it('offers to try again when Frameleaf Cloud cannot be reached', async () => {
      unlinked(MailSignInUnavailableReason.CloudUnreachable);
      await pick('Gmail');
      expect(await screen.findByText(en.frameleaf_notify_signin_unreachable_title)).toBeInTheDocument();
      await fireEvent.click(button('Try again'));
      await waitFor(() => expect(getMailConnection).toHaveBeenCalledTimes(2));
    });
  });

  describe('a provider Frameleaf Cloud has not configured', () => {
    it('does not offer Microsoft, and Gmail goes straight to its app password form', async () => {
      const { store } = open(config(), answer({ available: false, providers: [] }));
      await waitFor(() => expect(getMailConnection).toHaveBeenCalled());
      await pick('Gmail');

      expect(within(tiles()).queryByRole('button', { name: /^Microsoft/ })).not.toBeInTheDocument();
      expect(await screen.findByRole('textbox', { name: en.frameleaf_notify_delivery_address })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in with Google instead' })).not.toBeInTheDocument();
      expect(store.draft.notifications.smtp.transport.host).toBe('smtp.gmail.com');
    });

    it('offers only Gmail when the cloud offers only Gmail', async () => {
      open(config(), answer({ providers: [MailSignInProvider.Gmail] }));
      await pick('Gmail');
      expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
      expect(within(tiles()).queryByRole('button', { name: /^Microsoft/ })).not.toBeInTheDocument();
    });
  });

  describe('who emails come from, and the emails themselves (ADMIN-P3)', () => {
    const from = (saved: AdminConfigDto, sender: string) => {
      saved.notifications.smtp.from = sender;
      return saved;
    };
    const inboxRow = () => screen.getByText(en.frameleaf_notify_inbox).closest('.kit-row') as HTMLElement;

    it('shows the sender as an inbox will, and changes only its name under Advanced', async () => {
      const { store } = open(
        from(
          config({ host: 'mail.example.com', username: 'photos@example.com' }, true),
          'Rivera photos <photos@example.com>',
        ),
        answer(),
      );
      await waitFor(() => expect(within(inboxRow()).getByText('Rivera photos')).toBeInTheDocument());
      expect(within(inboxRow()).getByText('photos@example.com')).toBeInTheDocument();

      await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_notify_delivery_sender_name }), {
        target: { value: 'Home archive' },
      });
      expect(store.draft.notifications.smtp.from).toBe('Home archive <photos@example.com>');
      expect(within(inboxRow()).getByText('Home archive')).toBeInTheDocument();
    });

    it('shows the signed-in account’s own address when the saved sender names another', async () => {
      open(
        from(config({ type: MailTransportType.Gmail }, true), 'Rivera photos <photos@example.com>'),
        answer({ connection: connected() }),
      );
      await screen.findByText('Signed in as');
      expect(within(inboxRow()).getByText('rivera@gmail.com')).toBeInTheDocument();
      expect(within(inboxRow()).queryByText('Rivera photos')).not.toBeInTheDocument();
    });

    it('changes the wording of one email in plain words and keeps it as the template the server renders', async () => {
      const { store } = open(config({ host: 'mail.example.com' }, true), answer());
      // The old template editor is gone.
      expect(screen.queryByText('Email Templates')).not.toBeInTheDocument();

      await fireEvent.click(
        await screen.findByRole('button', { name: 'Edit the wording of the Welcome email', hidden: true }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Welcome email' });
      const box = within(dialog).getByRole('textbox', { name: 'Welcome email wording' });
      await fireEvent.input(box, { target: { value: 'Hello ' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: /Person’s name/ }));
      expect(box).toHaveValue('Hello [Person’s name]');
      expect(within(dialog).getByText('Hello Morgan')).toBeInTheDocument();

      await fireEvent.click(within(dialog).getByRole('button', { name: 'Use this wording' }));
      expect(store.draft.templates.email.welcomeTemplate).toBe('Hello {displayName}');
      expect(
        screen.getByText('Welcome email: your wording is ready. Save your changes to keep it.'),
      ).toBeInTheDocument();
    });
  });

  it('changes nothing on a server whose settings come from a configuration file', async () => {
    flags.configFile = true;
    open(config({ type: MailTransportType.Gmail }, true), answer({ connection: connected() }));
    expect(await screen.findByRole('button', { name: 'Disconnect…' })).toBeDisabled();
  });
});
