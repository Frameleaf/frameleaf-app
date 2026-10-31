import {
  getMailConnection,
  MailConnectionStatus,
  MailSignInProvider,
  MailSignInState,
  MailTransportType,
  type AdminConfigDto,
  type MailConnectionStateDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import NotificationsLanding from '$lib/components/frameleaf/settings/notifications/NotificationsLanding.svelte';
import en from '../../../../../../../i18n/en.json';

/**
 * Notifications opens on whether this server can send email. With a signed-in Google or Microsoft
 * account the provider wants signed in again (FL-379), it must not say "set up": email has stopped.
 */
const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const user = vi.hoisted(() => ({ isAdmin: true, email: 'taylor@example.com' }));

vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), getMailConnection: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { email: true, configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  getSystemConfigDraft: () => draft.store,
}));

const saved = (type: MailTransportType, enabled = true) => ({
  baseline: {
    notifications: {
      smtp: { enabled, from: '', replyTo: '', transport: { type, host: '', port: 587, secure: false, username: '' } },
    },
  } as unknown as AdminConfigDto,
});
const answer = (status: MailConnectionStatus): MailConnectionStateDto => ({
  available: true,
  providers: [MailSignInProvider.Gmail],
  connection: {
    provider: MailSignInProvider.Gmail,
    email: 'rivera@gmail.com',
    status,
    connectedAt: '2026-10-01T10:00:00.000Z',
  },
  signIn: MailSignInState.None,
});
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_notify_hero_label }));

describe('Notifications landing: email status (FL-368, FL-379)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    user.isAdmin = true;
  });

  it('says email stopped and offers to sign in again when the provider asks for a new sign-in', async () => {
    draft.store = saved(MailTransportType.Gmail);
    vi.mocked(getMailConnection).mockResolvedValue(answer(MailConnectionStatus.NeedsSignIn));
    render(NotificationsLanding, { sections: [] });

    expect(await hero().findByRole('heading', { name: 'Email stopped working' })).toBeInTheDocument();
    expect(hero().getByText(/Google is asking you to sign in again\./)).toBeInTheDocument();
    expect(hero().queryByRole('heading', { name: en.frameleaf_notify_hero_on })).not.toBeInTheDocument();

    await fireEvent.click(hero().getByRole('button', { name: 'Sign in again' }));
    expect(vi.mocked(goto).mock.calls[0][0]).toContain('area=notifications');
  });

  it('says email is set up while the signed-in account is working', async () => {
    draft.store = saved(MailTransportType.Gmail);
    vi.mocked(getMailConnection).mockResolvedValue(answer(MailConnectionStatus.Connected));
    render(NotificationsLanding, { sections: [] });

    await waitFor(() => expect(getMailConnection).toHaveBeenCalledTimes(1));
    // the answer has been applied, not just requested
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_on })).toBeInTheDocument();
    expect(hero().queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not ask about an account when email goes through a mail server', () => {
    draft.store = saved(MailTransportType.Smtp);
    render(NotificationsLanding, { sections: [] });

    expect(getMailConnection).not.toHaveBeenCalled();
    expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_on })).toBeInTheDocument();
  });

  it('says email is turned off for a signed-in account whose sending was switched off', async () => {
    draft.store = saved(MailTransportType.Gmail, false);
    vi.mocked(getMailConnection).mockResolvedValue(answer(MailConnectionStatus.NeedsSignIn));
    render(NotificationsLanding, { sections: [] });

    await waitFor(() => expect(getMailConnection).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_paused })).toBeInTheDocument();
    expect(hero().getByRole('button', { name: en.frameleaf_notify_turn_on })).toBeInTheDocument();
  });

  it('lists What needs your attention for an administrator under For you, and Email delivery for everyone (FL-421)', () => {
    draft.store = saved(MailTransportType.Smtp);
    const page = (key: string, title: string, admin?: boolean) => ({ key, title, subtitle: '', icon: '', admin });
    render(NotificationsLanding, {
      sections: [
        page('email-preferences', 'Emails you receive'),
        page('signals', en.frameleaf_cc_section_signals, true),
        page('notifications', 'Email delivery', true),
      ],
    });

    const forYou = within(screen.getByRole('region', { name: en.frameleaf_notify_for_you }));
    expect(forYou.getAllByRole('link').map((link) => link.querySelector('strong')?.textContent)).toEqual([
      'Emails you receive',
      en.frameleaf_cc_section_signals,
    ]);
    expect(forYou.getByRole('link', { name: new RegExp(en.frameleaf_cc_section_signals) })).toHaveAttribute(
      'href',
      '/user-settings?area=notifications&section=signals',
    );
    const everyone = within(screen.getByRole('region', { name: en.frameleaf_sharing_server_title }));
    expect(everyone.getAllByRole('link')).toHaveLength(1);
  });

  it('never asks the administrator-only question for a member', () => {
    user.isAdmin = false;
    draft.store = undefined;
    render(NotificationsLanding, { sections: [] });

    expect(getMailConnection).not.toHaveBeenCalled();
    expect(hero().getByRole('heading', { name: en.frameleaf_notify_hero_on })).toBeInTheDocument();
  });
});
