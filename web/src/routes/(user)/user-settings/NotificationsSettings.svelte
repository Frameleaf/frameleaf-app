<script lang="ts">
  /**
   * Notifications › Emails you receive (FL-368, after the approved prototype
   * `settings-v2/server/notifications.jsx`; the preferences are FL-77's). One table, "Tell me about",
   * with "In the app" (always: the bell cannot be turned off) and "By email" (the real switch).
   *
   * The fault this fixes: the switches used to read "Enabled" while this server's email was off,
   * which is the default, so nothing was sent and the page did not say so. Now a notice says the
   * server cannot send, the email switches are held (greyed, keeping the saved choice) and the way
   * to set email up is offered to an administrator.
   *
   * Turning "Send me emails" off also turns the two kinds off, as before. Changes wait for the Save bar.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tell, { type TellRow } from '$lib/components/frameleaf/settings/kit/Tell.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import { SECTION_KEYS } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  const store = createOwnPreferencesDraft(SECTION_KEYS.notifications);
  const draft = $derived(store.draft);

  /** Whether this server sends email at all (the server's email delivery switch). */
  const serverSends = $derived(featureFlagsManager.value.email);
  const mine = $derived(draft['emailNotifications.enabled']);

  const EMAILED = {
    shares: 'emailNotifications.albumInvite',
    updates: 'emailNotifications.albumUpdate',
  } as const;
  const rows = $derived<TellRow[]>([
    { id: 'shares', label: $t('frameleaf_notify_yours_shares'), help: $t('frameleaf_notify_yours_shares_help') },
    { id: 'updates', label: $t('frameleaf_notify_yours_updates'), help: $t('frameleaf_notify_yours_updates_help') },
    { id: 'mentions', label: $t('frameleaf_notify_yours_mentions'), help: $t('frameleaf_notify_yours_mentions_help') },
    { id: 'faces', label: $t('frameleaf_notify_yours_faces'), help: $t('frameleaf_notify_yours_faces_help') },
  ]);
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    {#if !serverSends}
      <Notice tone="warn" title={$t('frameleaf_notify_yours_cannot_send')}>
        {authManager.user.isAdmin
          ? $t('frameleaf_notify_yours_cannot_send_admin')
          : $t('frameleaf_notify_yours_cannot_send_member')}
        {#snippet action()}
          {#if authManager.user.isAdmin}
            <Button onclick={() => goto(commandCenterUrl('notifications', 'notifications'))}>
              {$t('frameleaf_notify_setup')}
            </Button>
          {/if}
        {/snippet}
      </Notice>
    {/if}

    <Section title={$t('frameleaf_notify_yours_email')}>
      <Row
        label={$t('frameleaf_notify_yours_send')}
        help={$t('frameleaf_notify_yours_send_help', { values: { email: authManager.user.email } })}
        link={{ text: $t('frameleaf_notify_yours_change_address'), href: commandCenterUrl('preferences', 'account') }}
      >
        <Switch
          label={$t('frameleaf_notify_yours_send')}
          checked={mine}
          held={!serverSends}
          onChange={(value) => store.setEmailNotifications(value)}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_notify_yours_tell')} description={$t('frameleaf_notify_yours_tell_description')}>
      <Tell
        heading={$t('frameleaf_notify_yours_tell')}
        columns={[$t('frameleaf_notify_yours_in_app'), $t('frameleaf_notify_yours_by_email')]}
        {rows}
      >
        {#snippet cell(row, column)}
          {#if column === 0}
            {$t('frameleaf_notify_yours_always')}
          {:else if row.id === 'shares' || row.id === 'updates'}
            {@const key = EMAILED[row.id]}
            <Switch
              label={$t('frameleaf_notify_yours_email_label', { values: { kind: row.label } })}
              checked={draft[key]}
              held={!serverSends || !mine}
              onChange={(value) => store.set(key, value)}
            />
          {:else}
            {$t('frameleaf_notify_yours_app_only')}
          {/if}
        {/snippet}
      </Tell>
    </Section>
  </KitPage>
</OwnPreferencesForm>
