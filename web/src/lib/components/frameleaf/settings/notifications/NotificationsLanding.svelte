<script lang="ts">
  /**
   * Notifications (FL-368, after the approved prototype `settings-v2/server/notifications.jsx`):
   * opens on whether this server can send email, lists "Emails you receive" first because every
   * account has it, and keeps Email delivery under "For everyone on this server" for administrators.
   *
   * The page says only what the app knows: whether sending is on, and for an administrator whether
   * a mail account has been entered. "Last sent" and "stopped working, with the reason" wait for the
   * server to record them, so the answer is "set up", never "working".
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
  import { mdiEmailCheckOutline, mdiEmailOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  const isAdmin = $derived(authManager.user.isAdmin);
  const smtp = $derived(getSystemConfigDraft()?.baseline.notifications.smtp);
  const sends = $derived(smtp?.enabled ?? featureFlagsManager.value.email);
  /** A mail account was entered and sending was then switched off: different from never set up. */
  const paused = $derived(!sends && !!smtp?.transport.host.trim());

  const hero = $derived(
    sends
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
        },
  );

  const rows = (admin: boolean) =>
    sections
      .filter((section) => Boolean(section.admin) === admin)
      .map((section): LinkRow => ({
        icon: section.icon,
        title: section.title,
        body: section.subtitle,
        href: commandCenterUrl('notifications', section.key),
      }));
</script>

<KitPage>
  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_notify_hero_label')}>
    {#snippet actions()}
      {#if isAdmin && !sends}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('notifications', 'notifications'))}>
          {paused ? $t('frameleaf_notify_turn_on') : $t('frameleaf_notify_setup')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_notify_for_you')}>
    <Links stacked rows={rows(false)} />
  </Section>

  {#if rows(true).length > 0}
    <Section title={$t('frameleaf_sharing_server_title')} description={$t('frameleaf_sharing_server_description')}>
      <Links stacked rows={rows(true)} />
    </Section>
  {/if}
</KitPage>
