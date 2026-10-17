<script lang="ts">
  /**
   * Notifications (FL-368, after the approved prototype `settings-v2/server/notifications.jsx`):
   * opens on whether this server can send email, lists "Emails you receive" first because every
   * account has it, and keeps Email delivery under "For everyone on this server" for administrators.
   *
   * The page says only what the app knows: whether sending is on, and for an administrator whether
   * a mail account has been entered. "Last sent" and "stopped working, with the reason" wait for the
   * server to record them, so the answer is "set up", never "working". The one exception is a
   * signed-in Google or Microsoft account the provider wants signed in again (FL-379): the server
   * records that, so an administrator is told email stopped, with the way to sign in again.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { providerOf, signInProviderFor } from '$lib/components/frameleaf/settings/notifications/mail-providers';
  import { getMailConnection, MailConnectionStatus, MailTransportType, type MailConnectionDto } from '@frameleaf/sdk';
  import {
    mdiEmailAlertOutline,
    mdiEmailCheckOutline,
    mdiEmailFastOutline,
    mdiEmailOffOutline,
    mdiEmailOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  const isAdmin = $derived(authManager.user.isAdmin);
  const smtp = $derived(getSystemConfigDraft()?.baseline.notifications.smtp);
  const sends = $derived(smtp?.enabled ?? featureFlagsManager.value.email);
  /**
   * FL-379: email saved to go through a signed-in Google or Microsoft account. Whether that account
   * still lets this server send is the server's to say, and only an administrator may ask, so an
   * administrator's page asks once it opens; until the answer arrives the page says "set up".
   */
  const signIn = $derived(
    smtp && (smtp.transport.type ?? MailTransportType.Smtp) !== MailTransportType.Smtp
      ? signInProviderFor(providerOf(smtp.transport))
      : undefined,
  );
  /** A mail account was entered and sending was then switched off: different from never set up. */
  const paused = $derived(!sends && (!!smtp?.transport.host.trim() || !!signIn));
  let connection = $state<MailConnectionDto | null>(null);
  $effect(() => {
    if (!isAdmin || !signIn) {
      connection = null;
      return;
    }
    let current = true;
    void getMailConnection()
      .then((state) => {
        if (current) {
          connection = state.connection;
        }
      })
      .catch(() => {
        // the Email delivery page says when the account cannot be checked
      });
    return () => {
      current = false;
    };
  });
  /** The provider is asking for a new sign-in: emails are not going out, whatever the switch says. */
  const stopped = $derived(
    sends &&
      !!signIn &&
      connection?.provider === signIn.provider &&
      connection.status === MailConnectionStatus.NeedsSignIn,
  );

  const hero = $derived.by(() => {
    if (stopped && signIn) {
      return {
        tone: 'warn' as const,
        icon: mdiEmailAlertOutline,
        title: $t('frameleaf_notify_hero_stopped'),
        body: $t('frameleaf_notify_hero_stopped_signin', { values: { who: signIn.who } }),
      };
    }
    return sends
      ? {
          tone: 'good' as const,
          icon: mdiEmailCheckOutline,
          title: $t('frameleaf_notify_hero_on'),
          body: $t('frameleaf_notify_hero_on_body'),
        }
      : {
          tone: 'quiet' as const,
          icon: mdiEmailOffOutline,
          title: paused ? $t('frameleaf_notify_hero_paused') : $t('frameleaf_notify_hero_off'),
          body: isAdmin ? $t('frameleaf_notify_hero_off_body') : $t('frameleaf_notify_hero_off_member'),
        };
  });

  const ROW_ICONS: Record<string, string> = {
    'email-preferences': mdiEmailOutline,
    notifications: mdiEmailFastOutline,
  };

  const rows = (admin: boolean) =>
    sections
      .filter((section) => Boolean(section.admin) === admin)
      .map((section): LinkRow => ({
        // The prototype's mail icons (settings-v2/server/notifications.jsx); the navigation keeps the bell.
        icon: ROW_ICONS[section.key] ?? section.icon,
        title: section.title,
        body: section.subtitle,
        href: commandCenterUrl('notifications', section.key),
      }));
</script>

<KitPage>
  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_notify_hero_label')}>
    {#snippet actions()}
      {#if stopped}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('notifications', 'notifications'))}>
          {$t('frameleaf_notify_signin_again')}
        </Button>
      {:else if isAdmin && !sends}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('notifications', 'notifications'))}>
          {paused ? $t('frameleaf_notify_turn_on') : $t('frameleaf_notify_setup')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_notify_for_you')} description={$t('frameleaf_notify_for_you_description')}>
    <Links stacked rows={rows(false)} />
  </Section>

  {#if rows(true).length > 0}
    <Section title={$t('frameleaf_sharing_server_title')} description={$t('frameleaf_notify_server_description')}>
      <Links stacked rows={rows(true)} />
    </Section>
  {/if}
</KitPage>
